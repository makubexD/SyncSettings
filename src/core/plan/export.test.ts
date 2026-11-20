import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readSnapshot, runPlan } from "../../adapters/fs.ts";
import type { RunContext } from "../../adapters/fs.ts";
import { parseV2 } from "../config/v2.ts";
import type { Profile } from "../config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
  SanitizeRule,
} from "../config/types.ts";
import type { LayerName } from "../layers/select.ts";
import type { MachineRecord } from "../machine/record.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { valuesFileText } from "../values/file.ts";
import { planExport } from "./export.ts";
import { renderRun } from "./run.ts";
import { NO_FAILURES } from "./types.ts";
import type {
  Action,
  DconfDumpResult,
  LocalEntry,
  NewSettingLine,
  Snapshot,
} from "./types.ts";

const CASE_ROOT = new URL("../../../tests/parity/cases/", import.meta.url);

const HOME = "/home/user";

const WINDOWS_HOME = "C:\\Users\\user";

const MODE = 0o644;

const STATUS_LINE = new RegExp(
  `^\\s*\\[?\\s*(${STATUS_WORDS.join("|")})\\s*\\]?\\s+(\\S+)`,
);

const OSES: readonly Os[] = ["linux", "windows", "macos"];

interface CaseOptions {
  readonly only?: readonly string[];
}

interface CaseCommand {
  readonly command: string;
  readonly options?: CaseOptions;
}

interface ParityCase {
  readonly configV2: unknown;
  readonly values?: Readonly<Record<string, string>>;
  readonly commands: readonly CaseCommand[];
}

function parityCase(name: string): ParityCase {
  return JSON.parse(
    readFileSync(new URL(`${name}/case.json`, CASE_ROOT), "utf8"),
  ) as ParityCase;
}

function configOf(name: string): Result<ConfigV2, ConfigError> {
  return parseV2(JSON.stringify(parityCase(name).configV2));
}

/** Every file under `root`, as paths relative to it with forward slashes. */
function listFiles(root: URL): readonly string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (url: URL, prefix: string): void => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(new URL(`${entry.name}/`, url), `${prefix}${entry.name}/`);
      } else {
        files.push(`${prefix}${entry.name}`);
      }
    }
  };
  visit(root, "");
  return files.sort();
}

/** Every folder under `root`, as paths relative to it with forward slashes. */
function listDirs(root: URL): readonly string[] {
  if (!existsSync(root)) {
    return [];
  }
  const dirs: string[] = [];
  const visit = (url: URL, prefix: string): void => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      dirs.push(`${prefix}${entry.name}`);
      visit(new URL(`${entry.name}/`, url), `${prefix}${entry.name}/`);
    }
  };
  visit(root, "");
  return dirs.sort();
}

function homeOf(os: Os): string {
  return os === "windows" ? WINDOWS_HOME : HOME;
}

function separatorOf(os: Os): string {
  return os === "windows" ? "\\" : "/";
}

function snapshotFor(name: string, os: Os): Snapshot | undefined {
  const config = configOf(name);
  if (!config.ok) {
    return undefined;
  }
  const home = homeOf(os);
  const separator = separatorOf(os);
  const repoFiles = new Map<string, Uint8Array>();
  for (const relative of listFiles(new URL(`${name}/repo/`, CASE_ROOT))) {
    repoFiles.set(
      relative,
      readFileSync(new URL(`${name}/repo/${relative}`, CASE_ROOT)),
    );
  }
  const localFiles = new Map<string, LocalEntry>();
  for (const relative of listFiles(new URL(`${name}/home/`, CASE_ROOT))) {
    const path = `${home}${separator}${relative.replaceAll("/", separator)}`;
    const local: LocalEntry = {
      kind: "file",
      path,
      bytes: readFileSync(new URL(`${name}/home/${relative}`, CASE_ROOT)),
      mode: MODE,
    };
    localFiles.set(path, local);
  }
  const localDirs = new Set<string>();
  for (const relative of listDirs(new URL(`${name}/home/`, CASE_ROOT))) {
    localDirs.add(`${home}${separator}${relative.replaceAll("/", separator)}`);
  }
  const options = parityCase(name).commands[0]?.options;
  return {
    config: config.value,
    os,
    home,
    cwd: home,
    repoFiles,
    localFiles,
    localDirs,
    values: parityCase(name).values ?? {},
    env: {},
    only: options?.only ?? [],
  };
}

/** A case snapshot whose config the tests know is valid. */
function validSnapshot(name: string, os: Os = "linux"): Snapshot {
  const snapshot = snapshotFor(name, os);
  if (snapshot === undefined) {
    throw new Error(`${name} has an invalid config`);
  }
  return snapshot;
}

interface Observed {
  readonly lines: readonly string[];
  readonly actions: readonly Action[];
  readonly code: number;
}

/** A case stopped by config validation never reaches a plan; exit 1, no lines. */
function runCase(name: string, os: Os = "linux"): Observed {
  const snapshot = snapshotFor(name, os);
  if (snapshot === undefined) {
    const config = configOf(name);
    return { lines: [], actions: [], code: config.ok ? 0 : config.error.code };
  }
  const plan = planExport(snapshot);
  const rendered = renderRun(plan, NO_FAILURES);
  const actions = plan.steps.flatMap((step) =>
    step.actions.map((entry) => entry.action),
  );
  return { lines: rendered.lines, actions, code: rendered.code };
}

/** The status lines of a plan, each as `WORD label`, as the parity runner reads them. */
function statusLines(lines: readonly string[]): readonly string[] {
  const shown: string[] = [];
  for (const line of lines) {
    const match = STATUS_LINE.exec(line);
    if (match !== null) {
      shown.push(`${match[1]} ${match[2]}`);
    }
  }
  return shown;
}

function expectedOutput(name: string, os: Os): readonly string[] {
  const suffix = os === "linux" ? "" : `.${os}`;
  const url = new URL(`${name}/expect${suffix}/output.txt`, CASE_ROOT);
  if (!existsSync(url)) {
    return [];
  }
  return readFileSync(url, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

interface ShownAction {
  readonly kind: string;
  readonly path: string;
  readonly text?: string;
  readonly mode?: number;
}

function shownActions(actions: readonly Action[]): readonly ShownAction[] {
  return actions.map((action) => {
    if (action.kind === "writeValues") {
      return { kind: action.kind, path: ".user-values.json" };
    }
    if (action.kind === "writeMachineValues") {
      return { kind: action.kind, path: "machine.json" };
    }
    const path = { path: action.path };
    switch (action.kind) {
      case "writeRepo":
      case "writeLocal":
        return {
          kind: action.kind,
          ...path,
          text: new TextDecoder().decode(action.bytes),
          ...(action.mode !== undefined ? { mode: action.mode } : {}),
        };
      case "writeState":
        return { kind: action.kind, ...path, text: action.text };
      case "chmod":
        return { kind: action.kind, ...path, mode: action.mode };
      default:
        return { kind: action.kind, ...path };
    }
  });
}

const LAYER_MODULES: ConfigV2["modules"] = {
  parity: { description: "Parity case files" },
};

const WORK_RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
  claude: "claude",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const JSON_BASE_TEXT = '{"a": 1, "list": ["x"], "obj": {"k": "base"}}';

const JSON_OS_TEXT = '{"list": ["y", "x"], "obj": {"k2": "os"}, "b": 2}';

const JSON_BASE_CHANGED_TEXT = `{
  "a": 1,
  "list": [
    "x"
  ],
  "obj": {
    "k": "base2"
  }
}
`;

const JSON_OS_CHANGED_TEXT = `{
  "list": [
    "y",
    "x"
  ],
  "obj": {
    "k2": "os"
  },
  "b": 5
}
`;

const JSON_PLACEHOLDER_CHANGED_TEXT = `{
  "path": "<PATH>",
  "b": 5
}
`;

const JSON_MERGED_TEXT = `{
  "a": 1,
  "list": [
    "x",
    "y"
  ],
  "obj": {
    "k": "base",
    "k2": "os"
  },
  "b": 2
}
`;

const JSON_NEW_SETTING_TEXT = `{
  "a": 1,
  "list": [
    "x",
    "y"
  ],
  "obj": {
    "k": "base",
    "k2": "os"
  },
  "b": 2,
  "q": 1
}
`;

const JSON_LIST_BASE_TEXT = '{"list": ["a"]}';

const JSON_LIST_ADDED_TEXT = `{
  "list": [
    "a",
    "b"
  ]
}
`;

const NEW_SETTING_BASE_TEXT = '{"baseKey": 1, "delta": ["x"]}';

const NEW_SETTING_OS_TEXT = '{"osKey": "linux"}';

const NEW_SETTING_LOCAL_TEXT =
  '{"baseKey": 1, "osKey": "linux", "delta": ["x", "new item"], "newKey": true}';

const NEW_SETTING_ITEM_LOCAL_TEXT =
  '{"baseKey": 1, "osKey": "linux", "delta": ["x", "new item"]}';

const NEW_SETTING_SANITIZED_LOCAL_TEXT =
  '{"baseKey": 1, "osKey": "linux", "tool": "/home/user/tools/tool"}';

const PROFILE_ITEM_TEXT = `{
  "delta": [
    "new item"
  ]
}
`;

const PROFILE_SETTINGS_FOLDER = "profiles/work-1/parity";

const PROFILE_SETTINGS_PATH = `${PROFILE_SETTINGS_FOLDER}/settings.json`;

const PROFILE_SETTINGS_TEXT = `{
  "q": 1
}
`;

const LOCAL_JSON = "/home/user/.config/parity/settings.json";

interface LayerSnapshotOptions {
  readonly entries: readonly ConfigV2Entry[];
  readonly repo: Readonly<Record<string, string>>;
  readonly local?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
  readonly profile?: Profile;
  readonly dconfDumps?: ReadonlyMap<string, DconfDumpResult>;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A snapshot holding a config v2 entry set with repo and local text files. */
function layeredSnapshot(os: Os, options: LayerSnapshotOptions): Snapshot {
  const home = homeOf(os);
  const separator = separatorOf(os);
  const repoFiles = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(options.repo)) {
    repoFiles.set(path, bytesOf(text));
  }
  const localFiles = new Map<string, LocalEntry>();
  const localDirs = new Set<string>();
  for (const [relative, text] of Object.entries(options.local ?? {})) {
    const path = `${home}${separator}${relative.replaceAll("/", separator)}`;
    localFiles.set(path, {
      kind: "file",
      path,
      bytes: bytesOf(text),
      mode: MODE,
    });
    localDirs.add(path.slice(0, path.lastIndexOf(separator)));
  }
  return {
    config: {
      schemaVersion: 2,
      modules: LAYER_MODULES,
      entries: options.entries,
    },
    os,
    home,
    cwd: home,
    repoFiles,
    localFiles,
    localDirs,
    values: options.values ?? {},
    env: {},
    only: [],
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.dconfDumps !== undefined
      ? { dconfDumps: options.dconfDumps }
      : {}),
  };
}

function profileOf(destinations: Readonly<Record<string, string>>): Profile {
  return {
    name: "work-1",
    modules: ["parity"],
    values: {},
    destinations,
    retired: false,
  };
}

function jsonEntry(extra: Partial<ConfigV2Entry> = {}): ConfigV2Entry {
  return {
    file: "parity/settings.json",
    module: "parity",
    merge: "json",
    localPath: "~/.config/parity/settings.json",
    ...extra,
  };
}

const IMPORT_BASE_TEXT = "# Base\n";

const IMPORT_LINUX_TEXT = "# Linux\n";

const IMPORT_WINDOWS_TEXT = "# Windows\n";

const IMPORT_MARKER_CRLF =
  "# Base\r\n<!-- mksync: layers below are written by mksync pull -->\r\n@CLAUDE.windows.md\r\n";

const IMPORT_VALUE = "/home/user/tools";

const IMPORT_PATH_RULES: readonly SanitizeRule[] = [
  { placeholder: "<PATH>", prompt: "Path" },
];

function importEntry(extra: Partial<ConfigV2Entry> = {}): ConfigV2Entry {
  return {
    file: "claude/CLAUDE.md",
    module: "parity",
    merge: "import",
    localPath: "~/.config/parity/CLAUDE.md",
    importName: "CLAUDE.{layer}.md",
    ...extra,
  };
}

/** A whole-file entry, the plain file merge type. */
function wholeEntry(file: string, localPath: string): ConfigV2Entry {
  return { file, module: "parity", merge: "whole", localPath };
}

/** A dir entry on every OS, so it writes to `dotfiles/common/<file>`. */
function dirEntry(extra: Partial<ConfigV2Entry> = {}): ConfigV2Entry {
  return {
    file: "dir",
    module: "parity",
    merge: "dir",
    localPath: "~/.config/parity/dir",
    ...extra,
  };
}

/** A context for running a plan whose repo root is a temporary folder. */
function runContextFor(repoRoot: string, root: string): RunContext {
  const state = join(root, "state");
  return {
    repoRoot,
    os: "linux",
    stateFolder: join(state, "sync-settings"),
    location: {
      recordFile: join(state, "machine.json"),
      profilesFolder: join(state, "profiles"),
      privateFiles: true,
    },
    env: {},
    now: () => new Date(0),
    pid: 1,
  };
}

interface ObservedPlan {
  readonly lines: readonly string[];
  readonly actions: readonly Action[];
  readonly code: number;
  readonly newSettings?: readonly NewSettingLine[];
}

/** The status lines, actions, exit code and new settings the export plan gives
 * a snapshot, with optional answers for the new settings. */
function observe(
  snapshot: Snapshot,
  answers?: ReadonlyMap<string, LayerName>,
): ObservedPlan {
  const plan = planExport(snapshot, answers);
  const rendered = renderRun(plan, NO_FAILURES);
  return {
    lines: rendered.lines,
    actions: plan.steps.flatMap((step) =>
      step.actions.map((entry) => entry.action),
    ),
    code: rendered.code,
    ...(plan.newSettings !== undefined
      ? { newSettings: plan.newSettings }
      : {}),
  };
}

describe("planExport", () => {
  test("export-adds", () => {
    // Act
    const result = runCase("export-adds");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("export-adds", "linux"),
    );
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: "dotfiles/common/parity" },
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/app.conf",
        text: "color = blue\n",
      },
      { kind: "chmod", path: "dotfiles/common/parity/app.conf", mode: MODE },
    ]);
  });

  test("export-excluded", () => {
    // Act
    const result = runCase("export-excluded");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("export-excluded", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine(
        "SKIPPED",
        "dotfiles/common/parity/x.log",
        "matches exclude pattern",
      ),
    );
  });

  test("export-local-missing", () => {
    // Act
    const result = runCase("export-local-missing");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("export-local-missing", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine(
        "SKIPPED",
        "dotfiles/common/parity/a.conf",
        "local file not found: /home/user/.config/parity/a.conf",
      ),
    );
  });

  test("should stop with the missing-value message when no value is cached", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry({
          sanitize: [{ placeholder: "<NAME>", prompt: "Full name" }],
        }),
      ],
      repo: { "dotfiles/common/parity/settings.json": '{"name": "<NAME>"}' },
      local: { ".config/parity/settings.json": '{"name": "Parity User"}' },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      "missing value for <NAME>: add it to .user-values.json",
    ]);
    expect(result.actions.some((action) => action.kind === "writeRepo")).toBe(
      false,
    );
  });

  test("export-modified", () => {
    // Act
    const result = runCase("export-modified");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("export-modified", "linux"),
    );
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/a.conf",
        text: "new\n",
      },
      { kind: "chmod", path: "dotfiles/common/parity/a.conf", mode: MODE },
    ]);
  });

  test("exports a file entry read through a local symlink", () => {
    // Arrange
    const config = configOf("export-modified");
    if (!config.ok) {
      throw new Error("export-modified has an invalid config");
    }
    const root = mkdtempSync(join(tmpdir(), "mksync-export-link-"));
    try {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const repoFile = join(repo, "dotfiles", "common", "parity", "a.conf");
      mkdirSync(dirname(repoFile), { recursive: true });
      writeFileSync(repoFile, "repo\n");
      const target = join(home, ".config", "parity", "a.conf.real");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "local\n");
      chmodSync(target, MODE);
      symlinkSync(target, join(home, ".config", "parity", "a.conf"));
      const snapshot = readSnapshot({
        repoRoot: repo,
        config: config.value,
        os: "linux",
        home,
        cwd: home,
        values: {},
        env: {},
        only: [],
      });

      // Act
      const plan = planExport(snapshot);

      // Assert
      expect(plan.lines).toContain(
        formatLine("MODIFIED", "dotfiles/common/parity/a.conf"),
      );
      const actions = plan.steps.flatMap((step) =>
        step.actions.map((entry) => entry.action),
      );
      expect(shownActions(actions)).toEqual([
        {
          kind: "writeRepo",
          path: "dotfiles/common/parity/a.conf",
          text: "local\n",
        },
        { kind: "chmod", path: "dotfiles/common/parity/a.conf", mode: MODE },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps skipping a dir entry's local symlink", () => {
    // Arrange
    const snapshot = validSnapshot("dir-export-removed");
    const localFile = "/home/user/.config/parity/dir/a.txt";
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localFile, { kind: "symlink", path: localFile });

    // Act
    const plan = planExport({ ...snapshot, localFiles });

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/parity/dir/a.txt", "symlink"),
    );
  });

  test("export-unchanged", () => {
    // Act
    const result = runCase("export-unchanged");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("export-unchanged", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
  });

  test("dir-export-removed", () => {
    // Act
    const result = runCase("dir-export-removed");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("dir-export-removed", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([
      {
        kind: "removeRepo",
        path: "dotfiles/common/parity/dir/b.txt",
        pruneUpTo: "dotfiles/common/parity/dir",
      },
    ]);
    expect(result.lines).toContain(
      formatLine(
        "REMOVED",
        "dotfiles/common/parity/dir/b.txt",
        "no longer in source",
      ),
    );
  });

  test("orphan-reported", () => {
    // Act
    const result = runCase("orphan-reported");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("orphan-reported", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine(
        "ORPHAN",
        "dotfiles/common/parity/stray.conf",
        "no entry in sync-config.json; git rm it or add an entry",
      ),
    );
  });

  test("only-dotdot", () => {
    // Act
    const result = runCase("only-dotdot");

    // Assert
    expect(statusLines(result.lines)).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.actions).toEqual([]);
    expect(result.lines).toEqual([
      "ERROR: dotfiles/common/../x is not synced on this machine.",
    ]);
  });

  test("platform-picks-os", () => {
    const written: Readonly<Record<Os, readonly string[]>> = {
      linux: [
        "dotfiles/linux/parity/lin.conf",
        "dotfiles/common/parity/com.conf",
      ],
      windows: [
        "dotfiles/windows/parity/win.conf",
        "dotfiles/common/parity/com.conf",
      ],
      macos: ["dotfiles/common/parity/com.conf"],
    };

    for (const os of OSES) {
      // Act
      const result = runCase("platform-picks-os", os);

      // Assert
      expect(statusLines(result.lines)).toEqual(
        expectedOutput("platform-picks-os", os),
      );
      expect(result.code).toBe(0);
      expect(
        shownActions(result.actions)
          .filter((action) => action.kind === "writeRepo")
          .map((action) => action.path),
      ).toEqual([...written[os]]);
    }
  });

  test("sanitize-longest-first", () => {
    // Act
    const result = runCase("sanitize-longest-first");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("sanitize-longest-first", "linux"),
    );
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: "dotfiles/common/parity" },
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/a.conf",
        text: "<B> <A>\n",
      },
      { kind: "chmod", path: "dotfiles/common/parity/a.conf", mode: MODE },
    ]);
    expect(result.lines).toContain(
      formatLine("ADDED", "dotfiles/common/parity/a.conf", "sanitized"),
    );
  });

  test("reports a file entry's parent failure with the repo folder", () => {
    // Arrange
    const snapshot = validSnapshot("export-adds");

    // Act
    const plan = planExport(snapshot);

    // Assert
    const step = plan.steps.find(
      (entry) => entry.label === "dotfiles/common/parity/app.conf",
    );
    expect(
      step?.actions.map((entry) => [entry.action.kind, entry.failure]),
    ).toEqual([
      ["mkdir", "cannot create dotfiles/common/parity"],
      ["writeRepo", "cannot copy to repo"],
      ["chmod", "cannot copy file mode"],
    ]);
  });

  test("reports a dir file's parent failure as cannot create parent folder", () => {
    // Arrange
    const snapshot = validSnapshot("dir-export-removed");
    const repoFiles = new Map(snapshot.repoFiles);
    repoFiles.delete("dotfiles/common/parity/dir/a.txt");
    const missingRepoFile = { ...snapshot, repoFiles };

    // Act
    const plan = planExport(missingRepoFile);

    // Assert
    const step = plan.steps.find(
      (entry) => entry.label === "dotfiles/common/parity/dir/a.txt",
    );
    expect(step?.actions[0]).toEqual({
      action: { kind: "mkdir", path: "dotfiles/common/parity/dir" },
      failure: "cannot create parent folder",
    });
  });

  test("should report a failed write and still export the other files", () => {
    // Arrange: the first file's repo target is a folder, so its write fails.
    const root = mkdtempSync(join(tmpdir(), "mksync-export-error-"));
    const repo = join(root, "repo");
    try {
      mkdirSync(join(repo, "dotfiles", "common", "parity", "plain.txt"), {
        recursive: true,
      });
      const snapshot = layeredSnapshot("linux", {
        entries: [
          wholeEntry("parity/plain.txt", "~/.config/parity/plain.txt"),
          wholeEntry("parity/tool.sh", "~/.config/parity/tool.sh"),
          wholeEntry("parity/named.conf", "~/.config/parity/named.conf"),
        ],
        repo: {
          "dotfiles/common/parity/plain.txt": "old\n",
          "dotfiles/common/parity/named.conf": "old\n",
        },
        local: {
          ".config/parity/plain.txt": "new\n",
          ".config/parity/tool.sh": "new\n",
          ".config/parity/named.conf": "new\n",
        },
      });
      const plan = planExport(snapshot);

      // Act
      const outcome = runPlan(plan, runContextFor(repo, root));
      const rendered = renderRun(plan, outcome);

      // Assert
      expect(statusLines(rendered.lines)).toEqual([
        "ERROR dotfiles/common/parity/plain.txt",
        "ADDED dotfiles/common/parity/tool.sh",
        "MODIFIED dotfiles/common/parity/named.conf",
      ]);
      expect(rendered.code).toBe(0);
      expect(
        readFileSync(
          join(repo, "dotfiles", "common", "parity", "tool.sh"),
          "utf8",
        ),
      ).toBe("new\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dir-symlink-removed", () => {
    // Arrange: a.txt is local, c.txt is a local symlink the repo still holds.
    const snapshot = layeredSnapshot("linux", {
      entries: [dirEntry()],
      repo: {
        "dotfiles/common/dir/a.txt": "a\n",
        "dotfiles/common/dir/c.txt": "c\n",
      },
      local: { ".config/parity/dir/a.txt": "a\n" },
    });
    const localLink = `${HOME}/.config/parity/dir/c.txt`;
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localLink, { kind: "symlink", path: localLink });

    // Act
    const result = observe({ ...snapshot, localFiles });

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/dir/a.txt",
      "SKIPPED dotfiles/common/dir/c.txt",
      "REMOVED dotfiles/common/dir/c.txt",
    ]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/dir/c.txt", "symlink"),
    );
    expect(result.lines).toContain(
      formatLine(
        "REMOVED",
        "dotfiles/common/dir/c.txt",
        "no longer in source",
      ),
    );
    expect(result.actions).toEqual([
      {
        kind: "removeRepo",
        path: "dotfiles/common/dir/c.txt",
        pruneUpTo: "dotfiles/common/dir",
      },
    ]);
    expect(result.code).toBe(0);
  });

  test("dir-symlink-only keeps the folder-empty rule", () => {
    // Arrange: the local folder holds only a symlink for the repo's one file.
    const snapshot = layeredSnapshot("linux", {
      entries: [dirEntry()],
      repo: { "dotfiles/common/dir/c.txt": "c\n" },
    });
    const localDir = `${HOME}/.config/parity/dir`;
    const localLink = `${localDir}/c.txt`;
    const localDirs = new Set(snapshot.localDirs);
    localDirs.add(localDir);
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localLink, { kind: "symlink", path: localLink });

    // Act
    const result = observe({ ...snapshot, localFiles, localDirs });

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "SKIPPED dotfiles/common/dir/c.txt",
      "SKIPPED dotfiles/common/dir/",
    ]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/dir/c.txt", "symlink"),
    );
    expect(result.lines).toContain(
      formatLine(
        "SKIPPED",
        "dotfiles/common/dir/",
        "local folder is empty; repo files kept",
      ),
    );
    expect(result.actions).toEqual([]);
    expect(result.code).toBe(0);
  });

  test("should keep the repo files when a dir holds only a symlink", () => {
    // Arrange
    const snapshot = validSnapshot("dir-export-empty-keeps-repo");
    const localDir = `${HOME}/.config/fixture/dir`;
    const localLink = `${localDir}/link.txt`;
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localLink, { kind: "symlink", path: localLink });
    const localDirs = new Set(snapshot.localDirs);
    localDirs.add(localDir);

    // Act
    const result = observe({ ...snapshot, localFiles, localDirs });

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "SKIPPED dotfiles/common/dir/link.txt",
      "SKIPPED dotfiles/common/dir/",
    ]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/dir/link.txt", "symlink"),
    );
    expect(result.lines).toContain(
      formatLine(
        "SKIPPED",
        "dotfiles/common/dir/",
        "local folder is empty; repo files kept",
      ),
    );
    expect(result.lines.some((line) => line.includes("REMOVED"))).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.code).toBe(0);
  });

  test("should report an unreadable dir file and keep its repo copy", () => {
    // Arrange
    const snapshot = validSnapshot("dir-import-extra");
    const localFile = "/home/user/.config/parity/dir/a.txt";
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localFile, { kind: "unreadable", path: localFile });
    const label = "dotfiles/common/parity/dir/a.txt";

    // Act
    const result = observe({ ...snapshot, localFiles });

    // Assert
    expect(statusLines(result.lines)).toEqual([
      `ERROR ${label}`,
      "ADDED dotfiles/common/parity/dir/extra.txt",
    ]);
    expect(result.lines).toContain(
      formatLine("ERROR", label, "cannot read local file"),
    );
    expect(result.lines.some((line) => line.includes("REMOVED"))).toBe(false);
    expect(
      result.actions.some(
        (action) =>
          (action.kind === "writeRepo" ||
            action.kind === "chmod" ||
            action.kind === "removeRepo") &&
          action.path === label,
      ),
    ).toBe(false);
    expect(result.code).toBe(0);
  });

  test("crlf-common-export-new", () => {
    // Arrange: a shared file local to Windows arrives with CRLF.
    const snapshot = layeredSnapshot("windows", {
      entries: [wholeEntry("parity/a.conf", "~/.config/parity/a.conf")],
      repo: {},
      local: { ".config/parity/a.conf": "a\r\nb\r\n" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "ADDED dotfiles/common/parity/a.conf",
    ]);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: "dotfiles/common/parity" },
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/a.conf",
        text: "a\nb\n",
      },
      { kind: "chmod", path: "dotfiles/common/parity/a.conf", mode: MODE },
    ]);
  });

  test("crlf-common-export-modified", () => {
    // Arrange: the repo holds LF; only the local file changed, with CRLF.
    const snapshot = layeredSnapshot("windows", {
      entries: [wholeEntry("parity/a.conf", "~/.config/parity/a.conf")],
      repo: { "dotfiles/common/parity/a.conf": "a\nb\n" },
      local: { ".config/parity/a.conf": "a\r\nc\r\n" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/common/parity/a.conf",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/a.conf",
        text: "a\nc\n",
      },
      { kind: "chmod", path: "dotfiles/common/parity/a.conf", mode: MODE },
    ]);
  });

  test("crlf-windows-export-keeps-crlf", () => {
    // Arrange: a Windows-only file keeps the line endings this OS wrote.
    const snapshot = layeredSnapshot("windows", {
      entries: [
        {
          ...wholeEntry("parity/a.conf", "~/.config/parity/a.conf"),
          os: ["windows"],
        },
      ],
      repo: { "dotfiles/windows/parity/a.conf": "x\n" },
      local: { ".config/parity/a.conf": "a\r\nb\r\n" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/windows/parity/a.conf",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/windows/parity/a.conf",
        text: "a\r\nb\r\n",
      },
      { kind: "chmod", path: "dotfiles/windows/parity/a.conf", mode: MODE },
    ]);
  });

  test("crlf-common-binary-export", () => {
    // Arrange: a NUL byte means the file is binary, so its bytes stay as they are.
    const snapshot = layeredSnapshot("windows", {
      entries: [wholeEntry("parity/a.conf", "~/.config/parity/a.conf")],
      repo: {},
      local: { ".config/parity/a.conf": "" },
    });
    const localPath = `${WINDOWS_HOME}\\.config\\parity\\a.conf`;
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localPath, {
      kind: "file",
      path: localPath,
      bytes: new Uint8Array([0x61, 0x00, 0x0d, 0x0a]),
      mode: MODE,
    });

    // Act
    const result = observe({ ...snapshot, localFiles });

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "ADDED dotfiles/common/parity/a.conf",
    ]);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: "dotfiles/common/parity" },
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/a.conf",
        text: "a\u0000\r\n",
      },
      { kind: "chmod", path: "dotfiles/common/parity/a.conf", mode: MODE },
    ]);
  });

  test("crlf-common-dir-export-new", () => {
    // Arrange: a new file in a shared dir entry, written by Windows with CRLF.
    const snapshot = layeredSnapshot("windows", {
      entries: [dirEntry()],
      repo: {},
      local: { ".config/parity/dir/new.txt": "y\r\n" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "ADDED dotfiles/common/dir/new.txt",
    ]);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: "dotfiles/common/dir" },
      {
        kind: "writeRepo",
        path: "dotfiles/common/dir/new.txt",
        text: "y\n",
      },
      { kind: "chmod", path: "dotfiles/common/dir/new.txt", mode: MODE },
    ]);
  });

});

describe("planExport values file", () => {
  test("should save the values it used when an entry with rules has a local file", () => {
    // Arrange
    const snapshot = snapshotFor("sanitize-longest-first", "linux");

    // Act
    const plan = snapshot === undefined ? undefined : planExport(snapshot);

    // Assert
    expect(plan?.prepare).toEqual([
      { kind: "writeValues", text: valuesFileText(snapshot?.values ?? {}) },
    ]);
  });
});

describe("planExport values on a machine", () => {
  test("should save a new machine value on the record, not .user-values.json", () => {
    // Arrange
    const profile = profileOf({});
    const snapshot: Snapshot = {
      ...layeredSnapshot("linux", {
        entries: [
          jsonEntry({
            sanitize: [
              {
                placeholder: "<HOME>",
                prompt: "Home folder",
                default: "/home/user",
              },
            ],
          }),
        ],
        repo: { "dotfiles/common/parity/settings.json": '{"home": "<HOME>"}' },
        local: { ".config/parity/settings.json": '{"home": "/home/user"}' },
      }),
      record: WORK_RECORD,
      profile,
    };

    // Act
    const plan = planExport(snapshot);

    // Assert
    expect(plan.prepare).toEqual([
      {
        kind: "writeMachineValues",
        record: { ...WORK_RECORD, values: { "<HOME>": "/home/user" } },
        profile: { ...profile, values: {} },
      },
    ]);
  });
});

const UNUSED_PROFILE_FILE = "profiles/work-1/other/unused.json";

const EXTENSIONLESS_JSON_FILE = "parity/settings";

const EXTENSIONLESS_JSON_LOCAL = ".config/parity/settings";

const EXTENSIONLESS_JSON_VALUE = '/home/user/a"b';

const EXTENSIONLESS_JSON_REPO_TEXT = '{"path": "<PATH>", "b": 2}';

const EXTENSIONLESS_JSON_CHANGED_TEXT = `{
  "path": "<PATH>",
  "b": 5
}
`;

describe("planExport layers", () => {
  test("should send a json change to the layer holding the key", () => {
    // Arrange
    const snapshot = validSnapshot("json-export-to-layer");

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/common/parity/settings.json",
      "MODIFIED dotfiles/linux/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/settings.json",
        text: JSON_BASE_CHANGED_TEXT,
      },
      {
        kind: "chmod",
        path: "dotfiles/common/parity/settings.json",
        mode: MODE,
      },
      {
        kind: "writeRepo",
        path: "dotfiles/linux/parity/settings.json",
        text: JSON_OS_CHANGED_TEXT,
      },
      {
        kind: "chmod",
        path: "dotfiles/linux/parity/settings.json",
        mode: MODE,
      },
    ]);
    expect(result.code).toBe(0);
  });

  test("should not report a profile layer file as an orphan", () => {
    // Arrange
    const base = validSnapshot("json-export-to-layer");
    const snapshot: Snapshot = {
      ...base,
      repoFiles: new Map([
        ...base.repoFiles,
        [UNUSED_PROFILE_FILE, new TextEncoder().encode("{}\n")],
      ]),
    };

    // Act
    const result = observe(snapshot);

    // Assert
    expect(
      result.lines.some((line) => line.includes(UNUSED_PROFILE_FILE)),
    ).toBe(false);
  });

  test("should send a new json array item to the one layer a base-only file has", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: { "dotfiles/common/parity/settings.json": JSON_LIST_BASE_TEXT },
      local: { ".config/parity/settings.json": JSON_LIST_ADDED_TEXT },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/common/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/common/parity/settings.json",
        text: JSON_LIST_ADDED_TEXT,
      },
      {
        kind: "chmod",
        path: "dotfiles/common/parity/settings.json",
        mode: MODE,
      },
    ]);
    expect(result.code).toBe(0);
  });

  test("should refuse a new json setting with no destination and write nothing", () => {
    // Arrange
    const snapshot = validSnapshot("json-new-setting-refused");

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "ERROR dotfiles/linux/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([]);
    expect(result.lines).toContain(
      formatLine(
        "ERROR",
        "dotfiles/linux/parity/settings.json",
        "new setting c: needs a destination",
      ),
    );
    expect(result.code).toBe(0);
  });

  test("should store an import entry's base change in the base layer", () => {
    // Arrange
    const snapshot = validSnapshot("import-block-edit-not-pushed");

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/common/claude/CLAUDE.md",
      "UNCHANGED dotfiles/linux/claude/CLAUDE.md",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/common/claude/CLAUDE.md",
        text: "# Base2\n@RTK.md\n",
      },
      { kind: "chmod", path: "dotfiles/common/claude/CLAUDE.md", mode: MODE },
    ]);
  });

  test("should print the import block edit note on the base's status line", () => {
    // Arrange
    const snapshot = validSnapshot("import-block-edit-not-pushed");

    // Act
    const result = observe(snapshot);

    // Assert
    expect(result.lines).toContain(
      formatLine(
        "MODIFIED",
        "dotfiles/common/claude/CLAUDE.md",
        "import block is written by mksync, edit not pushed",
      ),
    );
  });

  test("should leave a Windows side file unchanged when pull wrote it with CRLF", () => {
    // Arrange
    const snapshot = layeredSnapshot("windows", {
      entries: [importEntry()],
      repo: {
        "dotfiles/common/claude/CLAUDE.md": IMPORT_BASE_TEXT,
        "dotfiles/windows/claude/CLAUDE.md": IMPORT_WINDOWS_TEXT,
      },
      local: {
        ".config/parity/CLAUDE.md": IMPORT_MARKER_CRLF,
        ".config/parity/CLAUDE.windows.md": IMPORT_WINDOWS_TEXT.replaceAll(
          "\n",
          "\r\n",
        ),
      },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/claude/CLAUDE.md",
      "UNCHANGED dotfiles/windows/claude/CLAUDE.md",
    ]);
    expect(shownActions(result.actions)).toEqual([]);
  });

  test("should store a real value in the import base as its placeholder", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [importEntry({ sanitize: IMPORT_PATH_RULES })],
      repo: { "dotfiles/common/claude/CLAUDE.md": IMPORT_BASE_TEXT },
      local: {
        ".config/parity/CLAUDE.md": `${IMPORT_BASE_TEXT}path ${IMPORT_VALUE}\n`,
      },
      values: { "<PATH>": IMPORT_VALUE },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/common/claude/CLAUDE.md",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/common/claude/CLAUDE.md",
        text: `${IMPORT_BASE_TEXT}path <PATH>\n`,
      },
    ]);
  });

  test("should store a real value in an import side file as its placeholder", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [importEntry({ sanitize: IMPORT_PATH_RULES })],
      repo: {
        "dotfiles/common/claude/CLAUDE.md": IMPORT_BASE_TEXT,
        "dotfiles/linux/claude/CLAUDE.md": IMPORT_LINUX_TEXT,
      },
      local: {
        ".config/parity/CLAUDE.md": IMPORT_BASE_TEXT,
        ".config/parity/CLAUDE.linux.md": `${IMPORT_LINUX_TEXT}path ${IMPORT_VALUE}\n`,
      },
      values: { "<PATH>": IMPORT_VALUE },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/claude/CLAUDE.md",
      "MODIFIED dotfiles/linux/claude/CLAUDE.md",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/linux/claude/CLAUDE.md",
        text: `${IMPORT_LINUX_TEXT}path <PATH>\n`,
      },
    ]);
  });

  test("should write a sanitized value in a changed json layer as its placeholder", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry({ sanitize: [{ placeholder: "<PATH>", prompt: "Path" }] }),
      ],
      repo: {
        "dotfiles/common/parity/settings.json": '{"a": 1}',
        "dotfiles/linux/parity/settings.json": '{"path": "<PATH>", "b": 2}',
      },
      local: {
        ".config/parity/settings.json":
          '{"a": 1, "path": "/home/user/tools", "b": 5}',
      },
      values: { "<PATH>": "/home/user/tools" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/linux/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: "dotfiles/linux/parity/settings.json",
        text: JSON_PLACEHOLDER_CHANGED_TEXT,
      },
    ]);
    expect(result.lines).toContain(
      formatLine(
        "MODIFIED",
        "dotfiles/linux/parity/settings.json",
        "sanitized",
      ),
    );
  });

  test("should treat a merge json entry with no extension as json", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry({
          file: EXTENSIONLESS_JSON_FILE,
          localPath: `~/${EXTENSIONLESS_JSON_LOCAL}`,
          sanitize: [{ placeholder: "<PATH>", prompt: "Path" }],
        }),
      ],
      repo: {
        [`dotfiles/common/${EXTENSIONLESS_JSON_FILE}`]:
          EXTENSIONLESS_JSON_REPO_TEXT,
      },
      local: {
        [EXTENSIONLESS_JSON_LOCAL]: JSON.stringify({
          path: EXTENSIONLESS_JSON_VALUE,
          b: 5,
        }),
      },
      values: { "<PATH>": EXTENSIONLESS_JSON_VALUE },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      `MODIFIED dotfiles/common/${EXTENSIONLESS_JSON_FILE}`,
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: `dotfiles/common/${EXTENSIONLESS_JSON_FILE}`,
        text: EXTENSIONLESS_JSON_CHANGED_TEXT,
      },
    ]);
  });

  test("should report no new setting for an item the hydrated layer holds", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry({
          sanitize: [{ placeholder: "<HOMEDIR>", prompt: "Home folder" }],
        }),
      ],
      repo: {
        "dotfiles/common/parity/settings.json": '{"paths":["<HOMEDIR>/bin"]}',
        "dotfiles/linux/parity/settings.json": '{"osKey": 1}',
      },
      local: {
        ".config/parity/settings.json":
          '{"paths":["/home/user/bin"],"osKey": 1}',
      },
      values: { "<HOMEDIR>": "/home/user" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/linux/parity/settings.json",
    ]);
    expect(result.newSettings).toBeUndefined();
    expect(shownActions(result.actions)).toEqual([]);
  });

  test("should compare an import base through the hydrated bytes, not the raw layer", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        importEntry({
          sanitize: [{ placeholder: "<NOTE>", prompt: "Note" }],
        }),
      ],
      repo: {
        "dotfiles/common/claude/CLAUDE.md": "note <NOTE>\n",
      },
      local: {
        ".config/parity/CLAUDE.md": "note first\r\nsecond\n",
      },
      values: { "<NOTE>": "first\r\nsecond" },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/claude/CLAUDE.md",
    ]);
    expect(shownActions(result.actions)).toEqual([]);
  });

  test("should leave an unchanged layered json file alone", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": JSON_OS_TEXT,
      },
      local: { ".config/parity/settings.json": JSON_MERGED_TEXT },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/linux/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([]);
    expect(result.code).toBe(0);
  });

  test("should create the profile layer file a destination names", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": JSON_OS_TEXT,
      },
      local: { ".config/parity/settings.json": JSON_NEW_SETTING_TEXT },
      profile: profileOf({ "parity settings.json: q": "profile" }),
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      `ADDED ${PROFILE_SETTINGS_PATH}`,
    ]);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: PROFILE_SETTINGS_FOLDER },
      {
        kind: "writeRepo",
        path: PROFILE_SETTINGS_PATH,
        text: PROFILE_SETTINGS_TEXT,
      },
      { kind: "chmod", path: PROFILE_SETTINGS_PATH, mode: MODE },
    ]);
    expect(result.code).toBe(0);
  });

  test("should refuse a destination naming absent machine layer", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": JSON_OS_TEXT,
      },
      local: { ".config/parity/settings.json": JSON_NEW_SETTING_TEXT },
      profile: profileOf({ "parity settings.json: q": "machine" }),
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "ERROR dotfiles/linux/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([]);
    expect(result.lines).toContain(
      formatLine(
        "ERROR",
        "dotfiles/linux/parity/settings.json",
        "new setting q: needs a destination",
      ),
    );
    expect(result.code).toBe(0);
  });
});

describe("planExport new settings", () => {
  test("should list an unresolved array item and key with the error", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": NEW_SETTING_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": NEW_SETTING_OS_TEXT,
      },
      local: { ".config/parity/settings.json": NEW_SETTING_LOCAL_TEXT },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "ERROR dotfiles/linux/parity/settings.json",
      "ERROR dotfiles/linux/parity/settings.json",
    ]);
    expect(result.newSettings).toEqual([
      {
        module: "parity",
        file: "settings.json",
        path: "delta[]",
        kind: "item",
        what: 'delta[]: "new item"',
      },
      {
        module: "parity",
        file: "settings.json",
        path: "newKey",
        kind: "key",
        what: "newKey: true",
      },
    ]);
    expect(shownActions(result.actions)).toEqual([]);
    expect(result.code).toBe(0);
  });

  test("should show a new setting's sanitized value", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry({ sanitize: IMPORT_PATH_RULES })],
      repo: {
        "dotfiles/common/parity/settings.json": NEW_SETTING_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": NEW_SETTING_OS_TEXT,
      },
      local: {
        ".config/parity/settings.json": NEW_SETTING_SANITIZED_LOCAL_TEXT,
      },
      values: { "<PATH>": IMPORT_VALUE },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(result.newSettings).toEqual([
      {
        module: "parity",
        file: "settings.json",
        path: "tool",
        kind: "key",
        what: 'tool: "<PATH>/tool"',
      },
    ]);
    expect(result.lines.join("\n")).not.toContain(IMPORT_VALUE);
  });

  test("should write an answered item to the layer the answer names", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": NEW_SETTING_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": NEW_SETTING_OS_TEXT,
      },
      local: { ".config/parity/settings.json": NEW_SETTING_ITEM_LOCAL_TEXT },
      profile: profileOf({}),
    });
    const answers = new Map<string, LayerName>([
      ["parity settings.json: delta[]", "profile"],
    ]);

    // Act
    const result = observe(snapshot, answers);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      `ADDED ${PROFILE_SETTINGS_PATH}`,
    ]);
    expect(result.lines.some((line) => line.includes("ERROR"))).toBe(false);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: PROFILE_SETTINGS_FOLDER },
      {
        kind: "writeRepo",
        path: PROFILE_SETTINGS_PATH,
        text: PROFILE_ITEM_TEXT,
      },
      { kind: "chmod", path: PROFILE_SETTINGS_PATH, mode: MODE },
    ]);
    expect(result.newSettings).toBeUndefined();
  });

  test("should route a stored destination with no answers", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": NEW_SETTING_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": NEW_SETTING_OS_TEXT,
      },
      local: { ".config/parity/settings.json": NEW_SETTING_ITEM_LOCAL_TEXT },
      profile: profileOf({ "parity settings.json: delta[]": "os" }),
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/linux/parity/settings.json",
    ]);
    expect(result.lines.some((line) => line.includes("ERROR"))).toBe(false);
    expect(result.newSettings).toBeUndefined();
  });

  test("should not route another file's path from a stored destination", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry(),
        jsonEntry({
          file: "parity/other.json",
          localPath: "~/.config/parity/other.json",
        }),
      ],
      repo: {
        "dotfiles/common/parity/settings.json": NEW_SETTING_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": NEW_SETTING_OS_TEXT,
        "dotfiles/common/parity/other.json": NEW_SETTING_BASE_TEXT,
        "dotfiles/linux/parity/other.json": NEW_SETTING_OS_TEXT,
      },
      local: {
        ".config/parity/settings.json": NEW_SETTING_ITEM_LOCAL_TEXT,
        ".config/parity/other.json": NEW_SETTING_ITEM_LOCAL_TEXT,
      },
      profile: profileOf({ "parity settings.json: delta[]": "os" }),
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/linux/parity/settings.json",
      "ERROR dotfiles/linux/parity/other.json",
    ]);
    expect(result.newSettings).toEqual([
      {
        module: "parity",
        file: "other.json",
        path: "delta[]",
        kind: "item",
        what: 'delta[]: "new item"',
      },
    ]);
  });
});

const DCONF_PATH = "/org/gnome/parity/";

const DCONF_REPO_PATH = "dotfiles/linux/parity/dconf.ini";

/** An entry on every OS writes to the base root. */
const DCONF_COMMON_REPO_PATH = "dotfiles/common/parity/dconf.ini";

const DCONF_DUMP_TEXT = "[/]\nfont-name=Cantarell 11\ncolor-scheme=default\n";

const DCONF_FILTERED_TEXT = "[/]\nfont-name=Cantarell 11\n";

const DCONF_KEYS: readonly string[] = ["font-name"];

/** A dconf entry on Linux, or on every OS when `everyOs` is set. */
function dconfEntry(
  everyOs = false,
  extra: Partial<ConfigV2Entry> = {},
): ConfigV2Entry {
  return {
    file: "parity/dconf.ini",
    module: "parity",
    merge: "dconf",
    dconfPath: DCONF_PATH,
    ...(everyOs ? {} : { os: ["linux"] }),
    ...extra,
  };
}

interface DconfSnapshotOptions {
  readonly everyOs?: boolean;
  readonly keys?: readonly string[];
  readonly repo?: string;
  readonly dump?: DconfDumpResult;
}

/** A Linux snapshot with one dconf entry and, when given, its dump result. */
function dconfSnapshot(options: DconfSnapshotOptions): Snapshot {
  const extra = options.keys === undefined ? {} : { keys: options.keys };
  return layeredSnapshot("linux", {
    entries: [dconfEntry(options.everyOs === true, extra)],
    repo: options.repo === undefined ? {} : { [DCONF_REPO_PATH]: options.repo },
    ...(options.dump === undefined
      ? {}
      : { dconfDumps: new Map([[DCONF_PATH, options.dump]]) }),
  });
}

describe("planExport dconf", () => {
  test("should skip a dconf entry when dconf is not installed", () => {
    // Arrange
    const snapshot = dconfSnapshot({ dump: { kind: "missing" } });

    // Act
    const plan = planExport(snapshot);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_REPO_PATH, "dconf not installed"),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toEqual({
      kind: "export",
      onlyMatchedNothing: false,
      skipped: 1,
    });
  });

  test("should report an error when the dconf dump fails", () => {
    // Arrange
    const snapshot = dconfSnapshot({ dump: { kind: "failed" } });

    // Act
    const plan = planExport(snapshot);

    // Assert
    expect(plan.lines).toContain(
      formatLine("ERROR", DCONF_REPO_PATH, "dconf dump failed"),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toEqual({
      kind: "export",
      onlyMatchedNothing: false,
      skipped: 0,
    });
  });

  test("should skip an empty filtered dump with the dconf path", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      keys: ["missing-key"],
      dump: { kind: "ok", text: DCONF_DUMP_TEXT },
    });

    // Act
    const plan = planExport(snapshot);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_REPO_PATH, `no settings under ${DCONF_PATH}`),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toEqual({
      kind: "export",
      onlyMatchedNothing: false,
      skipped: 1,
    });
  });

  test("should add the filtered dump when the repo has no file", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      keys: DCONF_KEYS,
      dump: { kind: "ok", text: DCONF_DUMP_TEXT },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([`ADDED ${DCONF_REPO_PATH}`]);
    expect(shownActions(result.actions)).toEqual([
      { kind: "mkdir", path: "dotfiles/linux/parity" },
      {
        kind: "writeRepo",
        path: DCONF_REPO_PATH,
        text: DCONF_FILTERED_TEXT,
      },
    ]);
  });

  test("should modify the repo file when the filtered dump differs", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      keys: DCONF_KEYS,
      repo: "[/]\nfont-name=Old 10\n",
      dump: { kind: "ok", text: DCONF_DUMP_TEXT },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([`MODIFIED ${DCONF_REPO_PATH}`]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeRepo",
        path: DCONF_REPO_PATH,
        text: DCONF_FILTERED_TEXT,
      },
    ]);
  });

  test("should leave an unchanged dconf repo file alone", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      keys: DCONF_KEYS,
      repo: DCONF_FILTERED_TEXT,
      dump: { kind: "ok", text: DCONF_DUMP_TEXT },
    });

    // Act
    const result = observe(snapshot);

    // Assert
    expect(statusLines(result.lines)).toEqual([`UNCHANGED ${DCONF_REPO_PATH}`]);
    expect(result.actions).toEqual([]);
  });

  test("should keep a dconf entry skipped on Windows", () => {
    // Arrange
    const snapshot = layeredSnapshot("windows", {
      entries: [dconfEntry(true)],
      repo: {},
    });

    // Act
    const plan = planExport(snapshot);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_COMMON_REPO_PATH, "not supported yet"),
    );
    expect(plan.summary).toEqual({
      kind: "export",
      onlyMatchedNothing: false,
      skipped: 1,
    });
  });

  test("should keep a dconf entry skipped on Linux with no dump", () => {
    // Arrange
    const snapshot = dconfSnapshot({});

    // Act
    const plan = planExport(snapshot);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_REPO_PATH, "not supported yet"),
    );
    expect(plan.summary).toEqual({
      kind: "export",
      onlyMatchedNothing: false,
      skipped: 1,
    });
  });
});
