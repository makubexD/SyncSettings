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
import { readSnapshot } from "../../adapters/fs.ts";
import { parseV1 } from "../config/v1.ts";
import { parseV2 } from "../config/v2.ts";
import { convertV1 } from "../config/convert.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
} from "../config/types.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { valuesFileText } from "../values/file.ts";
import { planExport } from "./export.ts";
import { renderRun } from "./run.ts";
import { NO_FAILURES } from "./types.ts";
import type { Action, LocalEntry, Snapshot } from "./types.ts";

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
  readonly config?: unknown;
  readonly configV2?: unknown;
  readonly values?: Readonly<Record<string, string>>;
  readonly commands: readonly CaseCommand[];
}

function parityCase(name: string): ParityCase {
  return JSON.parse(
    readFileSync(new URL(`${name}/case.json`, CASE_ROOT), "utf8"),
  ) as ParityCase;
}

function configOf(name: string): Result<ConfigV2, ConfigError> {
  const parsed = parityCase(name);
  if (parsed.configV2 !== undefined) {
    return parseV2(JSON.stringify(parsed.configV2));
  }
  const v1 = parseV1(JSON.stringify(parsed.config));
  if (!v1.ok) {
    return v1;
  }
  return convertV1(v1.value);
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

const LOCAL_JSON = "/home/user/.config/parity/settings.json";

interface LayerSnapshotOptions {
  readonly entries: readonly ConfigV2Entry[];
  readonly repo: Readonly<Record<string, string>>;
  readonly local?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
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

interface ObservedPlan {
  readonly lines: readonly string[];
  readonly actions: readonly Action[];
  readonly code: number;
}

/** The status lines, actions and exit code the export plan gives a snapshot. */
function observe(snapshot: Snapshot): ObservedPlan {
  const plan = planExport(snapshot);
  const rendered = renderRun(plan, NO_FAILURES);
  return {
    lines: rendered.lines,
    actions: plan.steps.flatMap((step) =>
      step.actions.map((entry) => entry.action),
    ),
    code: rendered.code,
  };
}

describe("planExport", () => {
  test("export-adds", () => {
    // Act
    const result = runCase("export-adds");

    // Assert
    expect(statusLines(result.lines)).toEqual(expectedOutput("export-adds", "linux"));
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
    expect(statusLines(result.lines)).toEqual(expectedOutput("export-excluded", "linux"));
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/parity/x.log", "matches exclude pattern"),
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

  test("export-modified", () => {
    // Act
    const result = runCase("export-modified");

    // Assert
    expect(statusLines(result.lines)).toEqual(expectedOutput("export-modified", "linux"));
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
    expect(statusLines(result.lines)).toEqual(expectedOutput("export-unchanged", "linux"));
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
      { kind: "removeRepo", path: "dotfiles/common/parity/dir/b.txt" },
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
    expect(statusLines(result.lines)).toEqual(expectedOutput("orphan-reported", "linux"));
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

  test("platform-list-common", () => {
    // Act
    const result = runCase("platform-list-common");

    // Assert
    expect(statusLines(result.lines)).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.code).toBe(1);
  });

  test("platform-missing", () => {
    // Act
    const result = runCase("platform-missing");

    // Assert
    expect(statusLines(result.lines)).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.code).toBe(1);
  });

  test("platform-picks-os", () => {
    const written: Readonly<Record<Os, readonly string[]>> = {
      linux: ["dotfiles/linux/parity/lin.conf", "dotfiles/common/parity/com.conf"],
      windows: ["dotfiles/windows/parity/win.conf", "dotfiles/common/parity/com.conf"],
      macos: ["dotfiles/common/parity/com.conf"],
    };

    for (const os of OSES) {
      // Act
      const result = runCase("platform-picks-os", os);

      // Assert
      expect(statusLines(result.lines)).toEqual(expectedOutput("platform-picks-os", os));
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

const UNUSED_PROFILE_FILE = "profiles/work-1/other/unused.json";

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
      { kind: "chmod", path: "dotfiles/common/parity/settings.json", mode: MODE },
      {
        kind: "writeRepo",
        path: "dotfiles/linux/parity/settings.json",
        text: JSON_OS_CHANGED_TEXT,
      },
      { kind: "chmod", path: "dotfiles/linux/parity/settings.json", mode: MODE },
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
    expect(result.lines.some((line) => line.includes(UNUSED_PROFILE_FILE))).toBe(false);
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
      formatLine("MODIFIED", "dotfiles/linux/parity/settings.json", "sanitized"),
    );
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
});
