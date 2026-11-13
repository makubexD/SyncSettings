import { describe, expect, test } from "bun:test";
import {
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
import { convertV1 } from "../config/convert.ts";
import type { Profile } from "../config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
} from "../config/types.ts";
import { parseJson } from "../json/value.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { planImport } from "./import.ts";
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

const SYNC_HEAD = "0123456789abcdef0123456789abcdef01234567";

const LAST_SYNC_FILE = "/home/user/.local/state/sync-settings/last-sync";

interface CaseOptions {
  readonly force?: boolean;
  readonly only?: readonly string[];
}

interface CaseCommand {
  readonly command: string;
  readonly options?: CaseOptions;
  readonly stdin?: string;
}

interface ParityCase {
  readonly config: unknown;
  readonly values?: Readonly<Record<string, string>>;
  readonly commands: readonly CaseCommand[];
}

function parityCase(name: string): ParityCase {
  return JSON.parse(
    readFileSync(new URL(`${name}/case.json`, CASE_ROOT), "utf8"),
  ) as ParityCase;
}

function configOf(name: string): Result<ConfigV2, ConfigError> {
  const v1 = parseV1(JSON.stringify(parityCase(name).config));
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
    force: options?.force === true,
  };
}

/** The case's `stdin` as one answer per prompt, without the final empty line. */
function answersOf(name: string): readonly string[] {
  const stdin = parityCase(name).commands[0]?.stdin ?? "";
  if (stdin === "") {
    return [];
  }
  const lines = stdin.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

interface Observed {
  readonly lines: readonly string[];
  readonly actions: readonly Action[];
  readonly code: number;
}

/** The plan's output and every action it would run, steps first then finish. */
function runSnapshot(
  snapshot: Snapshot,
  answers: readonly string[],
): Observed {
  const plan = planImport(snapshot, answers);
  const rendered = renderRun(plan, NO_FAILURES);
  return {
    lines: rendered.lines,
    actions: [
      ...plan.steps.flatMap((step) =>
        step.actions.map((entry) => entry.action),
      ),
      ...plan.finish,
    ],
    code: rendered.code,
  };
}

/** A case stopped by config validation never reaches a plan; exit 1, no lines. */
function runCase(name: string, os: Os = "linux"): Observed {
  const snapshot = snapshotFor(name, os);
  if (snapshot === undefined) {
    const config = configOf(name);
    return { lines: [], actions: [], code: config.ok ? 0 : config.error.code };
  }
  return runSnapshot(snapshot, answersOf(name));
}

/** A case snapshot whose config the tests know is valid. */
function validSnapshot(name: string, os: Os = "linux"): Snapshot {
  const snapshot = snapshotFor(name, os);
  if (snapshot === undefined) {
    throw new Error(`${name} has an invalid config`);
  }
  return snapshot;
}

/** Case snapshot with git information the shared cases don't carry. */
function withGit(
  snapshot: Snapshot,
  head: string | undefined,
  porcelain: string | undefined,
): Snapshot {
  return {
    ...snapshot,
    ...(head !== undefined ? { head } : {}),
    ...(porcelain !== undefined ? { porcelain } : {}),
  };
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
      return { kind: action.kind, path: ".user-values.json", text: action.text };
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

function writeStateActions(observed: Observed): readonly Action[] {
  return observed.actions.filter((action) => action.kind === "writeState");
}

describe("planImport", () => {
  test("import-answer-no", () => {
    // Act
    const result = runCase("import-answer-no");

    // Assert
    expect(statusLines(result.lines)).toEqual(expectedOutput("import-answer-no", "linux"));
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/parity/a.conf", "user skipped"),
    );
  });

  test("import-eof-no-force", () => {
    // Act
    const result = runCase("import-eof-no-force");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("import-eof-no-force", "linux"),
    );
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      { kind: "backup", path: "/home/user/.config/parity/a.conf" },
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/a.conf",
        text: "new\n",
      },
    ]);
    expect(result.lines).toContain(
      formatLine(
        "UPDATED",
        "dotfiles/common/parity/a.conf",
        "backup saved as a.conf.bak",
      ),
    );
  });

  test("import-not-in-repo", () => {
    // Act
    const result = runCase("import-not-in-repo");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("import-not-in-repo", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/parity/a.conf", "not found in repo"),
    );
  });

  test("import-updated-backup", () => {
    // Act
    const result = runCase("import-updated-backup");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("import-updated-backup", "linux"),
    );
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      { kind: "backup", path: "/home/user/.config/parity/a.conf" },
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/a.conf",
        text: "new\n",
      },
    ]);
    expect(result.lines).toContain(
      formatLine(
        "UPDATED",
        "dotfiles/common/parity/a.conf",
        "backup saved as a.conf.bak",
      ),
    );
  });

  test("hydrate-creates", () => {
    // Act
    const result = runCase("hydrate-creates");

    // Assert
    expect(statusLines(result.lines)).toEqual(expectedOutput("hydrate-creates", "linux"));
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/git.conf",
        text: "[user]\n\tname = Parity User\n\temail = parity@example.com\n",
      },
    ]);
    expect(result.lines).toContain(
      formatLine("CREATED", "dotfiles/common/parity/git.conf"),
    );
  });

  test("hydrate-escape-backslashes", () => {
    // Act
    const result = runCase("hydrate-escape-backslashes");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("hydrate-escape-backslashes", "linux"),
    );
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/a.conf",
        text: "path=C:\\\\Tools\n",
      },
    ]);
    expect(result.lines).toContain(
      formatLine("CREATED", "dotfiles/common/parity/a.conf"),
    );
  });

  test("dir-import-extra", () => {
    // Act
    const result = runCase("dir-import-extra");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("dir-import-extra", "linux"),
    );
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine(
        "EXTRA",
        "dotfiles/common/parity/dir/extra.txt",
        "not in repo; kept",
      ),
    );
  });

  test("infer-value", () => {
    // Act
    const result = runCase("infer-value");

    // Assert
    expect(statusLines(result.lines)).toEqual(expectedOutput("infer-value", "linux"));
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine("UNCHANGED", "dotfiles/common/parity/a.conf"),
    );
  });

  test("missing-value-stops", () => {
    // Act
    const result = runCase("missing-value-stops");

    // Assert
    expect(statusLines(result.lines)).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.actions).toEqual([]);
    expect(result.lines).toEqual([
      "missing value for <YOUR_NAME>: add it to .user-values.json",
    ]);
  });

  test("only-one-file", () => {
    // Act
    const result = runCase("only-one-file");

    // Assert
    expect(statusLines(result.lines)).toEqual(expectedOutput("only-one-file", "linux"));
    expect(result.code).toBe(0);
    expect(shownActions(result.actions)).toEqual([
      { kind: "backup", path: "/home/user/.config/parity/a.conf" },
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/a.conf",
        text: "new-a\n",
      },
    ]);
    expect(result.lines).toContain(
      formatLine(
        "UPDATED",
        "dotfiles/common/parity/a.conf",
        "backup saved as a.conf.bak",
      ),
    );
  });

  test("only-not-synced", () => {
    // Act
    const result = runCase("only-not-synced");

    // Assert
    expect(statusLines(result.lines)).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.actions).toEqual([]);
    expect(result.lines).toEqual([
      "ERROR: dotfiles/common/parity/none is not synced on this machine.",
    ]);
  });
});

describe("planImport sync point", () => {
  test("records HEAD on a clean run that applied every entry", () => {
    // Arrange
    const snapshot = withGit(
      validSnapshot("import-updated-backup"),
      SYNC_HEAD,
      "",
    );

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(result.code).toBe(0);
    expect(writeStateActions(result)).toEqual([
      { kind: "writeState", path: LAST_SYNC_FILE, text: `${SYNC_HEAD}\n` },
    ]);
    expect(result.actions[result.actions.length - 1]?.kind).toBe("writeState");
    expect(result.lines).toContain(`  Sync point : ${SYNC_HEAD.slice(0, 7)}`);
  });

  test("skips HEAD when a prompt was answered no", () => {
    // Arrange
    const snapshot = withGit(validSnapshot("import-answer-no"), SYNC_HEAD, "");

    // Act
    const result = runSnapshot(snapshot, ["n"]);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines).not.toContain(`  Sync point : ${SYNC_HEAD.slice(0, 7)}`);
  });

  test("skips HEAD when --only was given", () => {
    // Arrange
    const snapshot = withGit(validSnapshot("only-one-file"), SYNC_HEAD, "");

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines).not.toContain(`  Sync point : ${SYNC_HEAD.slice(0, 7)}`);
  });

  test("skips HEAD when it does not resolve", () => {
    // Arrange
    const snapshot = withGit(validSnapshot("import-updated-backup"), undefined, "");

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines.some((line) => line.includes("Sync point :"))).toBe(false);
  });

  test("skips HEAD on a dirty tree", () => {
    // Arrange
    const snapshot = withGit(
      validSnapshot("import-updated-backup"),
      SYNC_HEAD,
      " M dotfiles/common/parity/a.conf\n",
    );

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines).not.toContain(`  Sync point : ${SYNC_HEAD.slice(0, 7)}`);
  });

  test("skips HEAD when git status is unavailable", () => {
    // Arrange
    const snapshot = withGit(
      validSnapshot("import-updated-backup"),
      SYNC_HEAD,
      undefined,
    );

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
  });

  test("skips HEAD when the run stops on an error", () => {
    // Arrange
    const snapshot = withGit(
      validSnapshot("missing-value-stops"),
      SYNC_HEAD,
      "",
    );

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(result.code).toBe(1);
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines).not.toContain(`  Sync point : ${SYNC_HEAD.slice(0, 7)}`);
  });
});

describe("planImport file steps", () => {
  test("groups an UPDATED file's backup and write under its status line", () => {
    // Arrange
    const snapshot = validSnapshot("import-updated-backup");

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0];
    expect(step?.label).toBe("dotfiles/common/parity/a.conf");
    expect(step?.counted).toBe(true);
    expect(plan.lines[step?.line ?? -1]).toBe(
      formatLine(
        "UPDATED",
        "dotfiles/common/parity/a.conf",
        "backup saved as a.conf.bak",
      ),
    );
    expect(
      step?.actions.map((entry) => [entry.action.kind, entry.failure]),
    ).toEqual([
      ["backup", "cannot create backup"],
      ["writeLocal", "cannot copy from repo"],
    ]);
    expect(step?.actions[0]?.action).toMatchObject({
      kind: "backup",
      path: "/home/user/.config/parity/a.conf",
      repoPath: "dotfiles/common/parity/a.conf",
    });
  });

  test("groups a CREATED file's write and points it at the repo file", () => {
    // Arrange
    const snapshot = validSnapshot("hydrate-creates");

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0];
    expect(step?.label).toBe("dotfiles/common/parity/git.conf");
    expect(step?.counted).toBe(true);
    expect(plan.lines[step?.line ?? -1]).toBe(
      formatLine("CREATED", "dotfiles/common/parity/git.conf"),
    );
    expect(
      step?.actions.map((entry) => [entry.action.kind, entry.failure]),
    ).toEqual([["writeLocal", "cannot write local file"]]);
    expect(step?.actions[0]?.action).toMatchObject({
      kind: "writeLocal",
      path: "/home/user/.config/parity/git.conf",
      modeFrom: "dotfiles/common/parity/git.conf",
    });
  });

  test("imports through a file entry's local symlink instead of skipping it", () => {
    // Arrange
    const config = configOf("import-updated-backup");
    if (!config.ok) {
      throw new Error("import-updated-backup has an invalid config");
    }
    const root = mkdtempSync(join(tmpdir(), "mksync-import-link-"));
    try {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const repoFile = join(repo, "dotfiles", "common", "parity", "a.conf");
      mkdirSync(dirname(repoFile), { recursive: true });
      writeFileSync(repoFile, "repo\n");
      const target = join(home, ".config", "parity", "a.conf.real");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "local\n");
      const localFile = join(home, ".config", "parity", "a.conf");
      symlinkSync(target, localFile);
      const snapshot = readSnapshot({
        repoRoot: repo,
        config: config.value,
        os: "linux",
        home,
        cwd: home,
        values: {},
        env: {},
        only: [],
        force: true,
      });

      // Act
      const plan = planImport(snapshot, []);

      // Assert
      expect(plan.lines).toContain(
        formatLine(
          "UPDATED",
          "dotfiles/common/parity/a.conf",
          "backup saved as a.conf.bak",
        ),
      );
      const step = plan.steps.find(
        (entry) => entry.label === "dotfiles/common/parity/a.conf",
      );
      expect(step?.actions.map((entry) => entry.action.kind)).toEqual([
        "backup",
        "writeLocal",
      ]);
      expect(step?.actions[0]?.action).toMatchObject({
        kind: "backup",
        path: localFile,
      });
      expect(step?.actions[1]?.action).toMatchObject({
        kind: "writeLocal",
        path: localFile,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps skipping a dir entry's local symlink", () => {
    // Arrange
    const snapshot = validSnapshot("dir-import-extra");
    const localFile = "/home/user/.config/parity/dir/a.txt";
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localFile, { kind: "symlink", path: localFile });

    // Act
    const plan = planImport({ ...snapshot, localFiles }, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", "dotfiles/common/parity/dir/a.txt", "symlink"),
    );
  });

  test("reports a dir file's copy failure as cannot copy from repo", () => {
    // Arrange
    const snapshot = validSnapshot("dir-import-extra");
    const localFiles = new Map(snapshot.localFiles);
    localFiles.delete("/home/user/.config/parity/dir/a.txt");
    const missingLocal = { ...snapshot, localFiles };

    // Act
    const plan = planImport(missingLocal, []);

    // Assert
    const step = plan.steps.find(
      (entry) => entry.label === "dotfiles/common/parity/dir/a.txt",
    );
    expect(
      step?.actions.map((entry) => [entry.action.kind, entry.failure]),
    ).toEqual([["writeLocal", "cannot copy from repo"]]);
  });

  test("puts the sync point in finish, outside every step", () => {
    // Arrange
    const snapshot = withGit(
      validSnapshot("import-updated-backup"),
      SYNC_HEAD,
      "",
    );

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.finish).toEqual([
      { kind: "writeState", path: LAST_SYNC_FILE, text: `${SYNC_HEAD}\n` },
    ]);
    expect(
      plan.steps.some((step) =>
        step.actions.some((entry) => entry.action.kind === "writeState"),
      ),
    ).toBe(false);
  });
});

describe("planImport values file", () => {
  test("should save the inferred value as the case's expected .user-values.json", () => {
    // Arrange
    const snapshot = snapshotFor("infer-value", "linux");
    const expected = readFileSync(
      new URL("infer-value/expect/values.json", CASE_ROOT),
      "utf8",
    );

    // Act
    const plan = snapshot === undefined ? undefined : planImport(snapshot, []);

    // Assert
    expect(plan?.prepare).toEqual([{ kind: "writeValues", text: expected }]);
  });

  test("should infer from an entry --only did not pick", () => {
    // Arrange
    const snapshot = validSnapshot("only-infers-from-all");
    const expected = readFileSync(
      new URL("only-infers-from-all/expect/values.json", CASE_ROOT),
      "utf8",
    );

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.prepare).toEqual([{ kind: "writeValues", text: expected }]);
    expect(statusLines(plan.lines)).toEqual([
      "CREATED dotfiles/common/parity/a.conf",
    ]);
  });

  test("should not write the values file when no entry has rules", () => {
    // Arrange
    const snapshot = snapshotFor("export-unchanged", "linux");

    // Act
    const plan = snapshot === undefined ? undefined : planImport(snapshot, []);

    // Assert
    expect(plan?.prepare ?? []).toEqual([]);
  });
});

const LAYER_MODULES: ConfigV2["modules"] = {
  parity: { description: "Parity case files" },
};

const WORK_PROFILE: Profile = {
  name: "work-1",
  modules: ["parity"],
  values: {},
  destinations: {},
  retired: false,
};

const JSON_BASE_TEXT = '{"a": 1, "list": ["x"], "obj": {"k": "base"}}';
const JSON_OS_TEXT = '{"list": ["y", "x"], "obj": {"k2": "os"}, "b": 2}';
const JSON_PROFILE_TEXT = '{"obj": {"k3": "profile"}, "c": 3}';
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
const JSON_MERGED_PROFILE_TEXT = `{
  "a": 1,
  "list": [
    "x",
    "y"
  ],
  "obj": {
    "k": "base",
    "k2": "os",
    "k3": "profile"
  },
  "b": 2,
  "c": 3
}
`;
const JSON_MERGED_CRLF_TEXT = JSON_MERGED_TEXT.replaceAll("\n", "\r\n");

const JSON_REORDERED_TEXT =
  '{"b": 2, "obj": {"k": "base", "k2": "os"}, "list": ["x", "y"], "a": 1}';
const JSON_SPACED_TEXT = `{  "a" : 1 ,
  "list" : [ "x" , "y" ] ,
  "obj" : { "k" : "base" , "k2" : "os" } ,
  "b" : 2  }
`;
const JSON_CHANGED_TEXT = JSON_MERGED_TEXT.replace('"a": 1', '"a": 2');

const PLACEHOLDER_BASE_TEXT = '{"a": 1}';
const PLACEHOLDER_OS_TEXT = '{"path": "<PATH>"}';
const PLACEHOLDER_VALUE = 'C:\\Tools\\app "x"';
const PLACEHOLDER_MERGED_TEXT = `{
  "a": 1,
  "path": "C:\\\\Tools\\\\app \\"x\\""
}
`;

const IMPORT_BASE_TEXT = "# Base\n@RTK.md\n";
const IMPORT_OS_TEXT = "# Linux\n";
const IMPORT_LOCAL_TEXT = `# Base
@RTK.md
<!-- mksync: layers below are written by mksync pull -->
@CLAUDE.linux.md
`;

const INVALID_JSON_TEXT = "{ not JSON";

const LOCAL_JSON = "/home/user/.config/parity/settings.json";

interface LayerSnapshotOptions {
  readonly entries: readonly ConfigV2Entry[];
  readonly repo: Readonly<Record<string, string>>;
  readonly local?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
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
  for (const relative of options.dirs ?? []) {
    localDirs.add(`${home}${separator}${relative.replaceAll("/", separator)}`);
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
    force: true,
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

function importEntry(): ConfigV2Entry {
  return {
    file: "claude/CLAUDE.md",
    module: "parity",
    merge: "import",
    localPath: "~/.config/parity/CLAUDE.md",
    importName: "CLAUDE.{layer}.md",
  };
}

describe("planImport json comparison", () => {
  const UNCHANGED_JSON_LINE = "UNCHANGED dotfiles/linux/parity/settings.json";
  const UPDATED_JSON_LINE = "UPDATED dotfiles/linux/parity/settings.json";

  function jsonLocalResult(local: string): Observed {
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": JSON_OS_TEXT,
      },
      local: { ".config/parity/settings.json": local },
    });
    return runSnapshot(snapshot, []);
  }

  test("should leave a json entry UNCHANGED when the local keys are reordered", () => {
    // Act
    const result = jsonLocalResult(JSON_REORDERED_TEXT);

    // Assert
    expect(statusLines(result.lines)).toEqual([UNCHANGED_JSON_LINE]);
    expect(result.actions).toEqual([]);
  });

  test("should leave a json entry UNCHANGED when the local file has CRLF on Linux", () => {
    // Act
    const result = jsonLocalResult(JSON_MERGED_CRLF_TEXT);

    // Assert
    expect(statusLines(result.lines)).toEqual([UNCHANGED_JSON_LINE]);
    expect(result.actions).toEqual([]);
  });

  test("should leave a json entry UNCHANGED when the local file has extra whitespace", () => {
    // Act
    const result = jsonLocalResult(JSON_SPACED_TEXT);

    // Assert
    expect(statusLines(result.lines)).toEqual([UNCHANGED_JSON_LINE]);
    expect(result.actions).toEqual([]);
  });

  test("should UPDATE a json entry when a local value changed", () => {
    // Act
    const result = jsonLocalResult(JSON_CHANGED_TEXT);

    // Assert
    expect(statusLines(result.lines)).toEqual([UPDATED_JSON_LINE]);
    expect(shownActions(result.actions)).toEqual([
      { kind: "backup", path: LOCAL_JSON },
      { kind: "writeLocal", path: LOCAL_JSON, text: JSON_MERGED_TEXT },
    ]);
  });
});

describe("planImport layers", () => {
  test("should merge a json entry's base and OS layers on Linux", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": JSON_OS_TEXT,
      },
      dirs: [".config/parity"],
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "CREATED dotfiles/linux/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: LOCAL_JSON,
        text: JSON_MERGED_TEXT,
      },
    ]);
  });

  test("should merge the profile layer and leave out a module it does not list", () => {
    // Arrange
    const snapshot: Snapshot = {
      ...layeredSnapshot("linux", {
        entries: [
          jsonEntry(),
          {
            file: "parity/b.txt",
            module: "other",
            merge: "whole",
            localPath: "~/.config/parity/b.txt",
          },
        ],
        repo: {
          "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
          "dotfiles/linux/parity/settings.json": JSON_OS_TEXT,
          "profiles/work-1/parity/settings.json": JSON_PROFILE_TEXT,
          "dotfiles/common/parity/b.txt": "other\n",
        },
        dirs: [".config/parity"],
      }),
      profile: WORK_PROFILE,
    };

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "CREATED profiles/work-1/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: LOCAL_JSON,
        text: JSON_MERGED_PROFILE_TEXT,
      },
    ]);
  });

  test("should merge a json entry's layers with CRLF on Windows", () => {
    // Arrange
    const snapshot = layeredSnapshot("windows", {
      entries: [jsonEntry()],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/windows/parity/settings.json": JSON_OS_TEXT,
      },
      dirs: [".config/parity"],
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "CREATED dotfiles/windows/parity/settings.json",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: "C:\\Users\\user\\.config\\parity\\settings.json",
        text: JSON_MERGED_CRLF_TEXT,
      },
    ]);
  });

  test("should JSON-escape a hydrated value in a later layer", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry({
          sanitize: [{ placeholder: "<PATH>", prompt: "Path" }],
        }),
      ],
      repo: {
        "dotfiles/common/parity/settings.json": PLACEHOLDER_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": PLACEHOLDER_OS_TEXT,
      },
      values: { "<PATH>": PLACEHOLDER_VALUE },
      dirs: [".config/parity"],
    });

    // Act
    const result = runSnapshot(snapshot, []);
    const written = shownActions(result.actions)[0];

    // Assert
    expect(written).toEqual({
      kind: "writeLocal",
      path: LOCAL_JSON,
      text: PLACEHOLDER_MERGED_TEXT,
    });
    const parsed = parseJson(PLACEHOLDER_MERGED_TEXT);
    expect(parsed.ok).toBe(true);
  });

  test("should write an import entry's OS layer as a side file", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [importEntry()],
      repo: {
        "dotfiles/common/claude/CLAUDE.md": IMPORT_BASE_TEXT,
        "dotfiles/linux/claude/CLAUDE.md": IMPORT_OS_TEXT,
      },
      local: { ".config/parity/CLAUDE.md": IMPORT_LOCAL_TEXT },
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/claude/CLAUDE.md",
      "CREATED dotfiles/linux/claude/CLAUDE.md",
    ]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/CLAUDE.linux.md",
        text: IMPORT_OS_TEXT,
      },
    ]);
    expect(result.lines).toContain(
      formatLine("UNCHANGED", "dotfiles/common/claude/CLAUDE.md"),
    );
  });

  test("should ERROR on a layer that is not valid JSON and go on", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [
        jsonEntry(),
        {
          file: "parity/a.txt",
          module: "parity",
          merge: "whole",
          localPath: "~/.config/parity/a.txt",
        },
      ],
      repo: {
        "dotfiles/common/parity/settings.json": JSON_BASE_TEXT,
        "dotfiles/linux/parity/settings.json": INVALID_JSON_TEXT,
        "dotfiles/common/parity/a.txt": "other\n",
      },
      dirs: [".config/parity"],
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(result.code).toBe(0);
    expect(statusLines(result.lines)).toEqual([
      "ERROR dotfiles/linux/parity/settings.json",
      "CREATED dotfiles/common/parity/a.txt",
    ]);
    expect(result.lines).toContain(
      formatLine(
        "ERROR",
        "dotfiles/linux/parity/settings.json",
        `not valid JSON: dotfiles/linux/parity/settings.json`,
      ),
    );
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeLocal",
        path: "/home/user/.config/parity/a.txt",
        text: "other\n",
      },
    ]);
  });
});
