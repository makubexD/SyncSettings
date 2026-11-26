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
import { parseV2 } from "../config/v2.ts";
import type { Profile } from "../config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
} from "../config/types.ts";
import { parseJson } from "../json/value.ts";
import type { MachineRecord } from "../machine/record.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { planCheck } from "./check.ts";
import { planExport } from "./export.ts";
import { importValueQuestions, planImport } from "./import.ts";
import { renderRun } from "./run.ts";
import { NO_FAILURES } from "./types.ts";
import type {
  Action,
  DconfDumpResult,
  LocalEntry,
  RunPlan,
  Snapshot,
} from "./types.ts";

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
  readonly resetValues?: boolean;
  readonly only?: readonly string[];
}

interface CaseCommand {
  readonly command: string;
  readonly options?: CaseOptions;
  readonly stdin?: string;
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
    force: options?.force === true,
    ...(options?.resetValues === true ? { resetValues: true } : {}),
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
function runSnapshot(snapshot: Snapshot, answers: readonly string[]): Observed {
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
      return {
        kind: action.kind,
        path: ".user-values.json",
        text: action.text,
      };
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
      case "dconfLoad":
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
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("import-answer-no", "linux"),
    );
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
      formatLine(
        "SKIPPED",
        "dotfiles/common/parity/a.conf",
        "not found in repo",
      ),
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
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("hydrate-creates", "linux"),
    );
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
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("infer-value", "linux"),
    );
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
      "missing value for <YOUR_NAME>: run mksync push or pull in a terminal to enter it",
    ]);
  });

  test("only-one-file", () => {
    // Act
    const result = runCase("only-one-file");

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("only-one-file", "linux"),
    );
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
    expect(result.lines).not.toContain(
      `  Sync point : ${SYNC_HEAD.slice(0, 7)}`,
    );
  });

  test("skips HEAD when --only was given", () => {
    // Arrange
    const snapshot = withGit(validSnapshot("only-one-file"), SYNC_HEAD, "");

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines).not.toContain(
      `  Sync point : ${SYNC_HEAD.slice(0, 7)}`,
    );
  });

  test("skips HEAD when it does not resolve", () => {
    // Arrange
    const snapshot = withGit(
      validSnapshot("import-updated-backup"),
      undefined,
      "",
    );

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(writeStateActions(result)).toEqual([]);
    expect(result.lines.some((line) => line.includes("Sync point :"))).toBe(
      false,
    );
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
    expect(result.lines).not.toContain(
      `  Sync point : ${SYNC_HEAD.slice(0, 7)}`,
    );
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
    expect(result.lines).not.toContain(
      `  Sync point : ${SYNC_HEAD.slice(0, 7)}`,
    );
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

  test("reports a local file it cannot read and writes nothing for it", () => {
    // Arrange
    const snapshot = validSnapshot("dir-import-extra");
    const localFile = "/home/user/.config/parity/dir/a.txt";
    const label = "dotfiles/common/parity/dir/a.txt";
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(localFile, { kind: "unreadable", path: localFile });

    // Act
    const plan = planImport({ ...snapshot, localFiles }, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("ERROR", label, "cannot read local file"),
    );
    expect(plan.lines).toContain(
      formatLine(
        "EXTRA",
        "dotfiles/common/parity/dir/extra.txt",
        "not in repo; kept",
      ),
    );
    expect(plan.steps.find((entry) => entry.label === label)).toBeUndefined();
    expect(
      plan.steps.some((entry) =>
        entry.actions.some(
          (item) =>
            item.action.kind === "writeLocal" && item.action.path === localFile,
        ),
      ),
    ).toBe(false);
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

describe("planImport reset values", () => {
  const LOCAL = "/home/user/.config/parity/a.conf";

  test("should ask again, replace the cached value and read the overwrite answer next", () => {
    // Arrange
    const snapshot = validSnapshot("reset-values-asks");
    const localFiles = new Map(snapshot.localFiles);
    localFiles.set(LOCAL, {
      kind: "file",
      path: LOCAL,
      bytes: bytesOf("name=Inferred Name\n"),
      mode: MODE,
    });
    // Without --force, so a wrong answer index would skip the overwrite.
    const reset: Snapshot = { ...snapshot, force: false, localFiles };
    const expectedValues = readFileSync(
      new URL("reset-values-asks/expect/values.json", CASE_ROOT),
      "utf8",
    );

    // Act
    const plan = planImport(reset, ["New Name", "y"]);

    // Assert
    expect(plan.prepare).toEqual([
      { kind: "writeValues", text: expectedValues },
    ]);
    expect(statusLines(plan.lines)).toEqual([
      "UPDATED dotfiles/common/parity/a.conf",
    ]);
    expect(
      shownActions(
        plan.steps.flatMap((step) => step.actions.map((entry) => entry.action)),
      ),
    ).toEqual([
      { kind: "backup", path: LOCAL },
      { kind: "writeLocal", path: LOCAL, text: "name=New Name\n" },
    ]);
  });
});

describe("import value questions", () => {
  const ASK_HEADER =
    "\n  Enter values to fill the placeholders in the config files:\n\n";
  const VALUE_REPO = "dotfiles/common/parity/a.conf";
  const VALUE_REPO_TEXT = "name = <YOUR_NAME>\n";
  const VALUE_LOCAL = "/home/user/.config/parity/a.conf";
  const VALUE_ENTRY: ConfigV2Entry = {
    file: "parity/a.conf",
    module: "parity",
    merge: "whole",
    localPath: "~/.config/parity/a.conf",
    sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name" }],
  };
  const NAME_VALUES = '{\n  "<YOUR_NAME>": "Jane Doe"\n}\n';
  const VALUE_FILE = "~/.config/parity/a.conf";
  const OTHER_FILE = "~/.config/parity/b.conf";
  const OTHER_REPO = "dotfiles/common/parity/b.conf";
  const OTHER_ENTRY: ConfigV2Entry = {
    ...VALUE_ENTRY,
    file: "parity/b.conf",
    localPath: OTHER_FILE,
  };

  function twoEntrySnapshot(): Snapshot {
    return layeredSnapshot("linux", {
      entries: [OTHER_ENTRY, VALUE_ENTRY],
      repo: { [VALUE_REPO]: VALUE_REPO_TEXT, [OTHER_REPO]: VALUE_REPO_TEXT },
    });
  }

  test("should name both files that need the value in entry order", () => {
    // Arrange
    const snapshot = twoEntrySnapshot();

    // Act
    const questions = importValueQuestions(snapshot);

    // Assert
    expect(questions).toEqual([
      {
        text: `${ASK_HEADER}  Full name (${OTHER_FILE}, ${VALUE_FILE}): `,
        hasDefault: false,
      },
    ]);
  });

  test("should leave out a file --only leaves out", () => {
    // Arrange
    const snapshot: Snapshot = { ...twoEntrySnapshot(), only: [VALUE_LOCAL] };

    // Act
    const questions = importValueQuestions(snapshot);

    // Assert
    expect(questions).toEqual([
      { text: `${ASK_HEADER}  Full name (${VALUE_FILE}): `, hasDefault: false },
    ]);
  });

  function valueSnapshot(entry: ConfigV2Entry): Snapshot {
    return layeredSnapshot("linux", {
      entries: [entry],
      repo: { [VALUE_REPO]: VALUE_REPO_TEXT },
    });
  }

  test("should ask once for a missing placeholder and save the answer", () => {
    // Arrange
    const snapshot = valueSnapshot(VALUE_ENTRY);

    // Act
    const questions = importValueQuestions(snapshot);
    const plan = planImport(snapshot, ["Jane Doe"]);

    // Assert
    expect(questions).toEqual([
      { text: `${ASK_HEADER}  Full name (${VALUE_FILE}): `, hasDefault: false },
    ]);
    expect(plan.prepare).toEqual([{ kind: "writeValues", text: NAME_VALUES }]);
    expect(
      shownActions(
        plan.steps.flatMap((step) => step.actions.map((entry) => entry.action)),
      ),
    ).toEqual([
      { kind: "mkdir", path: "/home/user/.config/parity" },
      { kind: "writeLocal", path: VALUE_LOCAL, text: "name = Jane Doe\n" },
    ]);
  });

  test("should stop with the missing-value error when the answer is empty", () => {
    // Arrange
    const snapshot = valueSnapshot(VALUE_ENTRY);

    // Act
    const plan = planImport(snapshot, [""]);

    // Assert
    expect(plan.code).toBe(1);
    expect(plan.missing).toBe("<YOUR_NAME>");
    expect(plan.lines).toEqual([
      "missing value for <YOUR_NAME>: run mksync push or pull in a terminal to enter it",
    ]);
    expect(plan.steps).toEqual([]);
  });

  test("should ask a repeated placeholder only once", () => {
    // Arrange
    const entry: ConfigV2Entry = {
      ...VALUE_ENTRY,
      sanitize: [
        { placeholder: "<YOUR_NAME>", prompt: "Full name" },
        { placeholder: "<YOUR_NAME>", prompt: "Name again" },
      ],
    };
    const snapshot = valueSnapshot(entry);

    // Act
    const questions = importValueQuestions(snapshot);
    const plan = planImport(snapshot, ["Jane Doe"]);

    // Assert
    expect(questions).toEqual([
      { text: `${ASK_HEADER}  Full name (${VALUE_FILE}): `, hasDefault: false },
    ]);
    expect(plan.prepare).toEqual([{ kind: "writeValues", text: NAME_VALUES }]);
  });

  test("should ask every placeholder with its default under --reset-values", () => {
    // Arrange
    const entry: ConfigV2Entry = {
      ...VALUE_ENTRY,
      sanitize: [
        { placeholder: "<YOUR_NAME>", prompt: "Full name" },
        { placeholder: "<HOME>", prompt: "Home folder" },
      ],
    };
    const snapshot: Snapshot = {
      ...layeredSnapshot("linux", {
        entries: [entry],
        repo: { [VALUE_REPO]: VALUE_REPO_TEXT },
        values: { "<YOUR_NAME>": "Old Name" },
      }),
      resetValues: true,
    };

    // Act
    const questions = importValueQuestions(snapshot);

    // Assert
    expect(questions).toEqual([
      {
        text: `${ASK_HEADER}  Full name (${VALUE_FILE}) [Old Name]: `,
        hasDefault: true,
      },
      { text: `  Home folder (${VALUE_FILE}): `, hasDefault: false },
    ]);
  });

  test("should show a suggestion as the question's default", () => {
    // Arrange
    const entry: ConfigV2Entry = {
      ...VALUE_ENTRY,
      sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name" }],
    };
    const snapshot: Snapshot = {
      ...layeredSnapshot("linux", {
        entries: [entry],
        repo: { [VALUE_REPO]: VALUE_REPO_TEXT },
      }),
      suggested: { "<YOUR_NAME>": "Ana Lopez" },
    };

    // Act
    const questions = importValueQuestions(snapshot);

    // Assert
    expect(questions).toEqual([
      {
        text: `${ASK_HEADER}  Full name (${VALUE_FILE}) [Ana Lopez]: `,
        hasDefault: false,
        suggestion: "Ana Lopez",
      },
    ]);
  });

  test("should show the cached value over a suggestion under --reset-values", () => {
    // Arrange
    const entry: ConfigV2Entry = {
      ...VALUE_ENTRY,
      sanitize: [
        { placeholder: "<YOUR_NAME>", prompt: "Full name" },
        { placeholder: "<HOME>", prompt: "Home folder" },
      ],
    };
    const snapshot: Snapshot = {
      ...layeredSnapshot("linux", {
        entries: [entry],
        repo: { [VALUE_REPO]: VALUE_REPO_TEXT },
        values: { "<YOUR_NAME>": "Old Name" },
      }),
      resetValues: true,
      suggested: { "<YOUR_NAME>": "Ana Lopez", "<HOME>": "/home/ana" },
    };

    // Act
    const questions = importValueQuestions(snapshot);

    // Assert
    expect(questions).toEqual([
      {
        text: `${ASK_HEADER}  Full name (${VALUE_FILE}) [Old Name]: `,
        hasDefault: true,
      },
      {
        text: `  Home folder (${VALUE_FILE}) [/home/ana]: `,
        hasDefault: false,
        suggestion: "/home/ana",
      },
    ]);
  });

  test("should stop at end of input when a reset question shows a suggestion over a default", () => {
    // Arrange
    const entry: ConfigV2Entry = {
      ...VALUE_ENTRY,
      sanitize: [
        {
          placeholder: "<YOUR_NAME>",
          prompt: "Full name",
          default: "Rule Name",
        },
      ],
    };
    const snapshot: Snapshot = {
      ...layeredSnapshot("linux", {
        entries: [entry],
        repo: { [VALUE_REPO]: VALUE_REPO_TEXT },
      }),
      resetValues: true,
      suggested: { "<YOUR_NAME>": "Ana Lopez" },
    };

    // Act
    const questions = importValueQuestions(snapshot);

    // Assert
    expect(questions).toEqual([
      {
        text: `${ASK_HEADER}  Full name (${VALUE_FILE}) [Ana Lopez]: `,
        hasDefault: false,
        suggestion: "Ana Lopez",
      },
    ]);
  });

  test("should ask no question when the check path plans a missing value", () => {
    // Arrange
    const snapshot = validSnapshot("missing-value-stops");

    // Act
    const plan = planCheck(snapshot);

    // Assert
    expect(
      plan.lines.some((line) => line.includes("Enter values to fill")),
    ).toBe(false);
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
  readonly excludePatterns?: readonly string[];
  readonly force?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dconfDumps?: ReadonlyMap<string, DconfDumpResult>;
  readonly loginHome?: string;
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
      ...(options.excludePatterns !== undefined
        ? { excludePatterns: options.excludePatterns }
        : {}),
    },
    os,
    home,
    cwd: home,
    repoFiles,
    localFiles,
    localDirs,
    values: options.values ?? {},
    env: options.env ?? {},
    only: [],
    force: options.force ?? true,
    ...(options.dconfDumps !== undefined
      ? { dconfDumps: options.dconfDumps }
      : {}),
    ...(options.loginHome !== undefined
      ? { loginHome: options.loginHome }
      : {}),
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

  test("should skip a side file that matches an exclude pattern", () => {
    // Arrange
    const snapshot = layeredSnapshot("linux", {
      entries: [importEntry()],
      repo: {
        "dotfiles/common/claude/CLAUDE.md": IMPORT_BASE_TEXT,
        "dotfiles/linux/claude/CLAUDE.md": IMPORT_OS_TEXT,
      },
      local: { ".config/parity/CLAUDE.md": IMPORT_LOCAL_TEXT },
      excludePatterns: ["*.linux.md"],
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/claude/CLAUDE.md",
      "SKIPPED dotfiles/linux/claude/CLAUDE.md",
    ]);
    expect(result.lines).toContain(
      formatLine(
        "SKIPPED",
        "dotfiles/linux/claude/CLAUDE.md",
        "matches exclude pattern",
      ),
    );
    expect(shownActions(result.actions)).toEqual([]);
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

describe("planImport values on a machine", () => {
  function recordSnapshot(
    record: MachineRecord,
    profile: Profile,
    entry: ConfigV2Entry,
    repo: Readonly<Record<string, string>>,
  ): Snapshot {
    return {
      ...layeredSnapshot("linux", {
        entries: [entry],
        repo,
      }),
      record,
      profile,
    };
  }

  test("should save a new machine value on the record, not the profile or .user-values.json", () => {
    // Arrange
    const snapshot = recordSnapshot(
      WORK_RECORD,
      WORK_PROFILE,
      {
        file: "parity/a.conf",
        module: "parity",
        merge: "whole",
        localPath: "~/.config/parity/a.conf",
        sanitize: [
          {
            placeholder: "<HOME>",
            prompt: "Home folder",
            default: "/home/user",
          },
        ],
      },
      { "dotfiles/common/parity/a.conf": "home = <HOME>\n" },
    );

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.prepare).toEqual([
      {
        kind: "writeMachineValues",
        record: { ...WORK_RECORD, values: { "<HOME>": "/home/user" } },
        profile: { ...WORK_PROFILE, values: {} },
      },
    ]);
  });

  test("should save a new profile value on the profile, not the record", () => {
    // Arrange
    const snapshot = recordSnapshot(
      WORK_RECORD,
      WORK_PROFILE,
      {
        file: "parity/a.conf",
        module: "parity",
        merge: "whole",
        localPath: "~/.config/parity/a.conf",
        sanitize: [
          {
            placeholder: "<YOUR_NAME>",
            prompt: "Full name",
            default: "Parity User",
          },
        ],
      },
      { "dotfiles/common/parity/a.conf": "name = <YOUR_NAME>\n" },
    );

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.prepare).toEqual([
      {
        kind: "writeMachineValues",
        record: { ...WORK_RECORD, values: {} },
        profile: { ...WORK_PROFILE, values: { "<YOUR_NAME>": "Parity User" } },
      },
    ]);
  });

  test("should save nothing when the record already holds every value", () => {
    // Arrange
    const snapshot = recordSnapshot(
      { ...WORK_RECORD, values: { "<HOME>": "/home/user" } },
      WORK_PROFILE,
      {
        file: "parity/a.conf",
        module: "parity",
        merge: "whole",
        localPath: "~/.config/parity/a.conf",
        sanitize: [
          {
            placeholder: "<HOME>",
            prompt: "Home folder",
            default: "/home/user",
          },
        ],
      },
      { "dotfiles/common/parity/a.conf": "home = <HOME>\n" },
    );

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.prepare).toEqual([]);
  });
});

const DCONF_PATH = "/org/gnome/parity/";

const DCONF_REPO_PATH = "dotfiles/linux/parity/dconf.ini";

const DCONF_COMMON_REPO_PATH = "dotfiles/common/parity/dconf.ini";

const DCONF_REPO_TEXT = "[/]\nfont-name=Cantarell 11\n";

const DCONF_OLD_DUMP = "[/]\nfont-name=Old 10\n\n";

const DCONF_MACHINE_ONLY_DUMP =
  "[/]\nfont-name=Cantarell 11\ncolor-scheme=default\n";

const DCONF_BACKUP_PATH =
  "/home/user/.local/state/sync-settings/dconf/dconf.ini.bak";

/** A dconf entry on Linux, or on every OS when `everyOs` is set. */
function dconfEntry(everyOs = false): ConfigV2Entry {
  return {
    file: "parity/dconf.ini",
    module: "parity",
    merge: "dconf",
    dconfPath: DCONF_PATH,
    ...(everyOs ? {} : { os: ["linux"] }),
  };
}

interface DconfSnapshotOptions {
  readonly repo?: Readonly<Record<string, string>>;
  readonly dump?: DconfDumpResult;
  readonly force?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loginHome?: string;
}

/** A Linux snapshot with one dconf entry and its dump. */
function dconfSnapshot(options: DconfSnapshotOptions = {}): Snapshot {
  return layeredSnapshot("linux", {
    entries: [dconfEntry()],
    repo:
      options.repo === undefined
        ? { [DCONF_REPO_PATH]: DCONF_REPO_TEXT }
        : options.repo,
    force: options.force ?? true,
    env: options.env ?? { HOME, USER: "user" },
    dconfDumps: new Map([
      [DCONF_PATH, options.dump ?? { kind: "ok", text: DCONF_OLD_DUMP }],
    ]),
    loginHome: options.loginHome ?? HOME,
  });
}

describe("planImport dconf", () => {
  test("should skip a dconf entry whose repo file is missing", () => {
    // Arrange
    const snapshot = dconfSnapshot({ repo: {} });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_REPO_PATH, "not found in repo"),
    );
    expect(plan.steps).toEqual([]);
  });

  test("should skip a dconf entry when dconf is not installed", () => {
    // Arrange
    const snapshot = dconfSnapshot({ dump: { kind: "missing" } });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_REPO_PATH, "dconf not installed"),
    );
    expect(plan.steps).toEqual([]);
  });

  test("should skip a dconf entry when HOME is not the login home", () => {
    // Arrange
    const snapshot = dconfSnapshot({ loginHome: "/home/other" });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine(
        "SKIPPED",
        DCONF_REPO_PATH,
        "HOME is not the login home; dconf left alone",
      ),
    );
    expect(plan.steps).toEqual([]);
  });

  test("should skip a dconf entry when XDG_CONFIG_HOME is not ~/.config", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      env: { HOME, USER: "user", XDG_CONFIG_HOME: "/tmp/config" },
    });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine(
        "SKIPPED",
        DCONF_REPO_PATH,
        "XDG_CONFIG_HOME is not ~/.config; dconf left alone",
      ),
    );
    expect(plan.steps).toEqual([]);
  });

  test("should report an error when the dconf dump fails", () => {
    // Arrange
    const snapshot = dconfSnapshot({ dump: { kind: "failed" } });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("ERROR", DCONF_REPO_PATH, "dconf dump failed"),
    );
    expect(plan.steps).toEqual([]);
  });

  test("should load a repo file into an empty dconf folder without backup", () => {
    // Arrange
    const snapshot = dconfSnapshot({ dump: { kind: "ok", text: "" } });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([`CREATED ${DCONF_REPO_PATH}`]);
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "dconfLoad",
        path: DCONF_PATH,
        text: DCONF_REPO_TEXT,
      },
    ]);
  });

  test("should leave dconf alone when every repo key is already set", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      dump: { kind: "ok", text: DCONF_MACHINE_ONLY_DUMP },
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([`UNCHANGED ${DCONF_REPO_PATH}`]);
    expect(result.actions).toEqual([]);
  });

  test("should back up the dump, then load, when a repo key differs", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      dump: { kind: "ok", text: DCONF_OLD_DUMP },
    });

    // Act
    const result = runSnapshot(snapshot, []);

    // Assert
    expect(statusLines(result.lines)).toEqual([`UPDATED ${DCONF_REPO_PATH}`]);
    expect(result.lines).toContain(
      formatLine("UPDATED", DCONF_REPO_PATH, "backup saved as dconf.ini.bak"),
    );
    expect(shownActions(result.actions)).toEqual([
      {
        kind: "writeState",
        path: DCONF_BACKUP_PATH,
        text: "[/]\nfont-name=Old 10\n",
      },
      {
        kind: "dconfLoad",
        path: DCONF_PATH,
        text: DCONF_REPO_TEXT,
      },
    ]);
  });

  test("should keep the backup in the dated folder under the repo path", () => {
    // Arrange
    const snapshot = dconfSnapshot({
      dump: { kind: "ok", text: DCONF_OLD_DUMP },
    });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.steps[0]?.actions[0]).toEqual({
      action: {
        kind: "writeState",
        path: DCONF_BACKUP_PATH,
        text: "[/]\nfont-name=Old 10\n",
        repoPath: DCONF_REPO_PATH,
      },
      failure: "cannot create backup",
    });
  });

  test("should update dconf when the overwrite prompt is accepted", () => {
    // Arrange
    const snapshot = dconfSnapshot({ force: false });

    // Act
    const result = runSnapshot(snapshot, [""]);

    // Assert
    expect(statusLines(result.lines)).toEqual([`UPDATED ${DCONF_REPO_PATH}`]);
    expect(result.actions.map((action) => action.kind)).toEqual([
      "writeState",
      "dconfLoad",
    ]);
  });

  test("should skip dconf when the overwrite prompt is declined", () => {
    // Arrange
    const snapshot = dconfSnapshot({ force: false });

    // Act
    const result = runSnapshot(snapshot, ["n"]);

    // Assert
    expect(result.lines).toContain(
      formatLine("SKIPPED", DCONF_REPO_PATH, "user skipped"),
    );
    expect(result.actions).toEqual([]);
  });

  test("should keep a dconf entry skipped on Windows", () => {
    // Arrange
    const snapshot = layeredSnapshot("windows", {
      entries: [dconfEntry(true)],
      repo: {},
    });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_COMMON_REPO_PATH, "not supported yet"),
    );
    expect(plan.steps).toEqual([]);
  });

  test("should keep a dconf entry skipped on macOS", () => {
    // Arrange
    const snapshot = layeredSnapshot("macos", {
      entries: [dconfEntry(true)],
      repo: {},
    });

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    expect(plan.lines).toContain(
      formatLine("SKIPPED", DCONF_COMMON_REPO_PATH, "not supported yet"),
    );
    expect(plan.steps).toEqual([]);
  });
});

const REAL_CONFIG_URL = new URL("../../../sync-config.json", import.meta.url);

const REAL_DOTFILES_URL = new URL("../../../dotfiles/", import.meta.url);

const REAL_HOME = "/home/fixture";

const REAL_LOGIN_HOME = "/home/fixture-login";

function realConfig(): ConfigV2 {
  const parsed = parseV2(readFileSync(REAL_CONFIG_URL, "utf8"));
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}

function realRepoFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const relative of listFiles(REAL_DOTFILES_URL)) {
    files.set(
      `dotfiles/${relative}`,
      readFileSync(new URL(relative, REAL_DOTFILES_URL)),
    );
  }
  return files;
}

/** A fixture value per placeholder, so no test reads a real value. */
function fixtureValues(config: ConfigV2): Readonly<Record<string, string>> {
  const placeholders = new Set<string>();
  for (const entry of config.entries) {
    for (const rule of entry.sanitize ?? []) {
      placeholders.add(rule.placeholder);
    }
  }
  return Object.fromEntries(
    [...placeholders].map((placeholder) => [
      placeholder,
      `fixture-${placeholder.slice(1, -1).toLowerCase()}`,
    ]),
  );
}

function dconfEntries(config: ConfigV2): readonly ConfigV2Entry[] {
  return config.entries.filter((entry) => entry.merge === "dconf");
}

function repoPathOf(config: ConfigV2, entry: ConfigV2Entry): string {
  const systems = entry.os ?? config.modules[entry.module]?.os;
  const os = systems?.length === 1 ? systems[0] : undefined;
  return `dotfiles/${os ?? "common"}/${entry.file}`;
}

/** One dump result for every dconf entry's folder. */
function realDumps(
  config: ConfigV2,
  dump: DconfDumpResult,
): Map<string, DconfDumpResult> {
  const dumps = new Map<string, DconfDumpResult>();
  for (const entry of dconfEntries(config)) {
    if (entry.dconfPath !== undefined) {
      dumps.set(entry.dconfPath, dump);
    }
  }
  return dumps;
}

interface RealSnapshotOptions {
  readonly loginHome?: string;
  readonly dconfDumps?: ReadonlyMap<string, DconfDumpResult>;
}

function realSnapshot(
  config: ConfigV2,
  options: RealSnapshotOptions = {},
): Snapshot {
  return {
    config,
    os: "linux",
    home: REAL_HOME,
    cwd: REAL_HOME,
    repoFiles: realRepoFiles(),
    localFiles: new Map<string, LocalEntry>(),
    localDirs: new Set<string>(),
    values: fixtureValues(config),
    env: {},
    only: [],
    force: true,
    ...(options.loginHome !== undefined
      ? { loginHome: options.loginHome }
      : {}),
    ...(options.dconfDumps !== undefined
      ? { dconfDumps: options.dconfDumps }
      : {}),
  };
}

/** Adds every folder of `path` under `home` to `dirs`. */
function addParentDirs(dirs: Set<string>, path: string, home: string): void {
  let dir = path;
  for (;;) {
    const slash = dir.lastIndexOf("/");
    if (slash <= 0) {
      return;
    }
    dir = dir.slice(0, slash);
    if (dir !== home && !dir.startsWith(`${home}/`)) {
      return;
    }
    dirs.add(dir);
  }
}

/** The snapshot an import plan would leave behind: its written local files. */
function importedSnapshot(snapshot: Snapshot, plan: RunPlan): Snapshot {
  const localFiles = new Map<string, LocalEntry>();
  for (const step of plan.steps) {
    for (const entry of step.actions) {
      const action = entry.action;
      if (action.kind !== "writeLocal") {
        continue;
      }
      localFiles.set(action.path, {
        kind: "file",
        path: action.path,
        bytes: action.bytes,
        mode: MODE,
      });
    }
  }
  const localDirs = new Set<string>();
  for (const path of localFiles.keys()) {
    addParentDirs(localDirs, path, snapshot.home);
  }
  return { ...snapshot, localFiles, localDirs };
}

describe("planImport on the repo's own config", () => {
  test("should round-trip the real config and dotfiles (real-config-roundtrip)", () => {
    // Arrange
    const config = realConfig();
    const snapshot = realSnapshot(config, {
      loginHome: REAL_LOGIN_HOME,
      dconfDumps: realDumps(config, { kind: "ok", text: "" }),
    });
    expect(dconfEntries(config).length).toBeGreaterThan(0);

    // Act
    const imported = planImport(snapshot, []);

    // Assert
    expect(imported.lines.some((line) => line.includes("ERROR"))).toBe(false);
    for (const entry of dconfEntries(config)) {
      expect(imported.lines).toContain(
        formatLine(
          "SKIPPED",
          repoPathOf(config, entry),
          "HOME is not the login home; dconf left alone",
        ),
      );
    }

    // Act
    const exported = planExport(importedSnapshot(snapshot, imported));

    // Assert
    expect(
      statusLines(exported.lines).filter((line) =>
        /^(MODIFIED|ADDED|REMOVED|ORPHAN) /.test(line),
      ),
    ).toEqual([]);
  });

  test("should create every dconf entry from its repo file (real-config-dconf-restore)", () => {
    // Arrange
    const config = realConfig();
    const snapshot = realSnapshot(config, {
      loginHome: REAL_HOME,
      dconfDumps: realDumps(config, { kind: "ok", text: "" }),
    });
    expect(dconfEntries(config).length).toBeGreaterThan(0);

    // Act
    const plan = planImport(snapshot, []);

    // Assert
    for (const entry of dconfEntries(config)) {
      const label = repoPathOf(config, entry);
      const dconfPath = entry.dconfPath;
      if (dconfPath === undefined) {
        throw new Error(`${label} has no dconfPath`);
      }
      expect(plan.lines).toContain(formatLine("CREATED", label));
      const step = plan.steps.find((item) => item.label === label);
      expect(step?.actions).toHaveLength(1);
      expect(step?.actions[0]?.action).toEqual({
        kind: "dconfLoad",
        path: dconfPath,
        text: new TextDecoder().decode(snapshot.repoFiles.get(label)),
      });
    }
  });
});
