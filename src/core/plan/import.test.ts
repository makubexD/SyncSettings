import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseV1 } from "../config/v1.ts";
import { convertV1 } from "../config/convert.ts";
import type { ConfigError, ConfigV2, Os, Result } from "../config/types.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { planImport } from "./import.ts";
import type { Action, LocalEntry, Plan, Snapshot } from "./types.ts";

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

function runSnapshot(snapshot: Snapshot, answers: readonly string[]): Plan {
  return planImport(snapshot, answers);
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

function writeStateActions(plan: Plan): readonly Action[] {
  return plan.actions.filter((action) => action.kind === "writeState");
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
