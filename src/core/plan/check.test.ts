import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseV1 } from "../config/v1.ts";
import { convertV1 } from "../config/convert.ts";
import type { ConfigError, ConfigV2, Os, Result } from "../config/types.ts";
import type { MachineRecord } from "../machine/record.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { planCheck } from "./check.ts";
import { planPreview } from "./preview.ts";
import type { LocalEntry, Plan, Snapshot } from "./types.ts";

const CASE_ROOT = new URL("../../../tests/parity/cases/", import.meta.url);

const HOME = "/home/user";

const MODE = 0o644;

/** A record naming the profile and machine a missing value could go in. */
const RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work",
  os: "linux",
  hostname: "wk1",
  domain: null,
  claude: "none",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const CHECK_WORDS = [...STATUS_WORDS, "CREATE", "UPDATE"];

const STATUS_LINE = new RegExp(
  `^\\s*\\[?\\s*(${CHECK_WORDS.join("|")})\\s*\\]?\\s+(\\S+)`,
);

const MISSING_VALUE_CASE = "missing-value-stops";

const MISSING_VALUE_LABEL = "dotfiles/common/parity/a.conf";

const NEEDS_VALUES_NOTE = "needs values: run mksync setup";

const CHECK_CASE = "check-one-change";

const CHECK_REPO_FILE = "dotfiles/common/parity/app.conf";

const CHECK_LOCAL_FILE = `${HOME}/.config/parity/app.conf`;

const PULL_HEADER = "Changes from the repo:";

const MATCHES_REPO = "  This machine matches the repo.";

interface CaseOptions {
  readonly only?: readonly string[];
}

interface CaseCommand {
  readonly command: string;
  readonly options?: CaseOptions;
}

interface ParityCase {
  readonly config: unknown;
  readonly values?: Readonly<Record<string, string>>;
  readonly commands: readonly CaseCommand[];
  readonly git?: string;
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

function separatorOf(os: Os): string {
  return os === "windows" ? "\\" : "/";
}

/**
 * A snapshot of a shared case. A case run on a commit has `HEAD` equal to the
 * repo tree it ships, so `headFiles` is that same tree.
 */
function snapshotFor(name: string, os: Os = "linux"): Snapshot | undefined {
  const config = configOf(name);
  if (!config.ok) {
    return undefined;
  }
  const home = os === "windows" ? "C:\\Users\\user" : HOME;
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
  const git = parityCase(name).git;
  const committed = git === "committed" || git === "remote";
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
    ...(committed ? { headFiles: repoFiles } : {}),
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

function expectedOutput(name: string): readonly string[] {
  const url = new URL(`${name}/expect/output.txt`, CASE_ROOT);
  if (!existsSync(url)) {
    return [];
  }
  return readFileSync(url, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function expectedExit(name: string): number {
  return Number(
    readFileSync(new URL(`${name}/expect/exit`, CASE_ROOT), "utf8").trim(),
  );
}

function runCase(name: string, plan: (snapshot: Snapshot) => Plan): Plan {
  const snapshot = snapshotFor(name);
  if (snapshot === undefined) {
    const config = configOf(name);
    return { actions: [], lines: [], code: config.ok ? 0 : config.error.code };
  }
  return plan(snapshot);
}

/** A copy of `snapshot` with one local file replaced, for the one-change preview. */
function withLocalBytes(
  snapshot: Snapshot,
  path: string,
  bytes: Uint8Array,
): Snapshot {
  const localFiles = new Map(snapshot.localFiles);
  localFiles.set(path, { kind: "file", path, bytes, mode: MODE });
  return { ...snapshot, localFiles };
}

/** A copy of `snapshot` with the machine record this run reads. */
function withRecord(snapshot: Snapshot, record: MachineRecord): Snapshot {
  return { ...snapshot, record };
}

describe("planCheck", () => {
  test("check-one-change", () => {
    // Act
    const result = runCase("check-one-change", planCheck);

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("check-one-change"),
    );
    expect(result.code).toBe(expectedExit("check-one-change"));
    expect(result.actions).toEqual([]);
    expect(result.lines.some((line) => line.includes("IMPORT CHECK"))).toBe(
      true,
    );
    expect(result.lines).toContain(
      "  1 file(s) would change. mksync pull overwrites them (each keeps a .bak).",
    );
    expect(result.lines).toContain(
      "  If you changed them on this machine, run mksync push first.",
    );
  });

  test("should print the grouped block when the import would change a file", () => {
    // Act
    const result = runCase(CHECK_CASE, planCheck);

    // Assert
    expect(result.code).toBe(3);
    expect(result.lines).toContain(PULL_HEADER);
    expect(result.lines).toContain("All machines");
    expect(result.lines).toContain("Linux machines");
    expect(result.lines.indexOf(PULL_HEADER)).toBeLessThan(
      result.lines.indexOf(
        "  1 file(s) would change. mksync pull overwrites them (each keeps a .bak).",
      ),
    );
  });

  test("should print no grouped block when the import would change nothing", () => {
    // Arrange
    const snapshot = snapshotFor(CHECK_CASE);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }
    const repoBytes = snapshot.repoFiles.get(CHECK_REPO_FILE);
    expect(repoBytes).toBeDefined();
    if (repoBytes === undefined) {
      return;
    }

    // Act
    const result = planCheck(
      withLocalBytes(snapshot, CHECK_LOCAL_FILE, repoBytes),
    );

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(MATCHES_REPO);
    expect(result.lines).not.toContain(PULL_HEADER);
    expect(result.lines).not.toContain("All machines");
  });

  test("should flag a missing value when no record names a profile or machine", () => {
    // Act
    const result = runCase(MISSING_VALUE_CASE, planCheck);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      `SKIPPED ${MISSING_VALUE_LABEL}`,
    ]);
    expect(result.code).toBe(3);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", MISSING_VALUE_LABEL, NEEDS_VALUES_NOTE),
    );
    expect(
      result.lines.some((line) => line.includes("missing value for")),
    ).toBe(false);
  });

  test("should flag a missing value when a record names where it could go", () => {
    // Arrange
    const snapshot = snapshotFor(MISSING_VALUE_CASE);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }

    // Act
    const result = planCheck(withRecord(snapshot, RECORD));

    // Assert
    expect(statusLines(result.lines)).toEqual([
      `SKIPPED ${MISSING_VALUE_LABEL}`,
    ]);
    expect(result.code).toBe(3);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      formatLine("SKIPPED", MISSING_VALUE_LABEL, NEEDS_VALUES_NOTE),
    );
    expect(
      result.lines.some((line) => line.includes("missing value for")),
    ).toBe(false);
  });
});

describe("planPreview", () => {
  test("preview-no-change", () => {
    // Act
    const result = runCase("preview-no-change", planPreview);

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("preview-no-change"),
    );
    expect(result.code).toBe(expectedExit("preview-no-change"));
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain(
      "  Nothing would be sent: the repo matches HEAD.",
    );
    expect(result.lines).toContain(
      "  Nothing was written. Run mksync push to send it.",
    );
  });

  test("preview-only-refused", () => {
    // Act
    const result = runCase("preview-only-refused", planPreview);

    // Assert
    expect(statusLines(result.lines)).toEqual(
      expectedOutput("preview-only-refused"),
    );
    expect(result.code).toBe(expectedExit("preview-only-refused"));
    expect(result.actions).toEqual([]);
    expect(result.lines).toEqual([
      "ERROR: --preview cannot be combined with --only.",
    ]);
  });

  test("preview-one-change", () => {
    // Arrange
    const snapshot = snapshotFor("preview-no-change");
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }
    const changed = withLocalBytes(
      snapshot,
      `${HOME}/.config/parity/a.conf`,
      new TextEncoder().encode("new\n"),
    );

    // Act
    const result = planPreview(changed);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "MODIFIED dotfiles/common/parity/a.conf",
    ]);
    expect(result.code).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.lines).toContain("  1 file(s) would change.");
    expect(result.lines).not.toContain(
      "  Nothing would be sent: the repo matches HEAD.",
    );
  });

  test("should show a change exported earlier but not committed", () => {
    // Arrange: the repo and the machine agree, but the repo differs from HEAD.
    const snapshot = snapshotFor("preview-no-change");
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }
    const exportedBytes = new TextEncoder().encode("new\n");
    const local = withLocalBytes(
      snapshot,
      `${HOME}/.config/parity/a.conf`,
      exportedBytes,
    );
    const repoFiles = new Map(snapshot.repoFiles);
    repoFiles.set("dotfiles/common/parity/a.conf", exportedBytes);
    const uncommitted: Snapshot = {
      ...local,
      repoFiles,
      headFiles: snapshot.repoFiles,
    };

    // Act
    const result = planPreview(uncommitted);

    // Assert
    expect(statusLines(result.lines)).toEqual([
      "UNCHANGED dotfiles/common/parity/a.conf",
    ]);
    expect(result.actions).toEqual([]);
    expect(result.lines).not.toContain(
      "  Nothing would be sent: the repo matches HEAD.",
    );
  });

  test("preview-without-head-refused", () => {
    // Arrange: the same case, but no commit for the preview to compare with.
    const snapshot = snapshotFor("preview-no-change");
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }
    const { headFiles: _headFiles, ...withoutHead } = snapshot;

    // Act
    const result = planPreview(withoutHead);

    // Assert
    expect(result.code).toBe(1);
    expect(result.actions).toEqual([]);
    expect(result.lines).toEqual([
      "ERROR: --preview needs a git repo with a commit.",
    ]);
  });
});
