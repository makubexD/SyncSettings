import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBash, runLeakScan } from "./leakscan.ts";

const SYNC_PATHS = ["dotfiles", "sync-config.json"];

const HIT_LINE = "dotfiles/common/git/config:3: email";

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-leakscan-"));
  tempFolders.push(folder);
  return folder;
}

interface ScanFixture {
  readonly root: string;
  readonly log: string;
}

/** A repo with a fake `scripts/ci/leak-scan.sh` that logs its call and runs
 * `body`. */
function repoWithScan(body: string): ScanFixture {
  const root = tempFolder();
  const log = join(tempFolder(), "scan.log");
  const script = join(root, "scripts", "ci", "leak-scan.sh");
  mkdirSync(join(root, "scripts", "ci"), { recursive: true });
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$PWD" "$*" >> '${log}'\n${body}\n`,
  );
  chmodSync(script, 0o755);
  return { root, log };
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("runLeakScan", () => {
  test("should report a scan that exits 0 as clean", async () => {
    // Arrange
    const { root } = repoWithScan("exit 0");

    // Act
    const result = await runLeakScan(root, SYNC_PATHS);

    // Assert
    expect(result.kind).toBe("clean");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("should report exit 1 as hits with the scan's output", async () => {
    // Arrange
    const { root } = repoWithScan(`printf '%s\\n' '${HIT_LINE}'\nexit 1`);

    // Act
    const result = await runLeakScan(root, SYNC_PATHS);

    // Assert
    expect(result.kind).toBe("hits");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(HIT_LINE);
  });

  test("should report any other exit as could not run", async () => {
    // Arrange
    const { root } = repoWithScan("printf 'ERROR: scan failed\\n' >&2\nexit 2");

    // Act
    const result = await runLeakScan(root, SYNC_PATHS);

    // Assert
    expect(result.kind).toBe("could-not-run");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("ERROR: scan failed");
  });

  test("should report a missing script as could not run", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await runLeakScan(root, SYNC_PATHS);

    // Assert
    expect(result.kind).toBe("could-not-run");
    expect(result.code).toBe(-1);
  });

  test("should run the script in the repo root with the given paths", async () => {
    // Arrange
    const { root, log } = repoWithScan("exit 0");
    const expected = `${root}|${SYNC_PATHS.join(" ")}`;

    // Act
    await runLeakScan(root, SYNC_PATHS);

    // Assert
    expect(readFileSync(log, "utf8").trim()).toBe(expected);
  });
});

describe("findBash", () => {
  const GIT_ROOT = "C:\\Program Files\\Git";
  const GIT_BASH = `${GIT_ROOT}\\bin\\bash.exe`;

  test("should use bash from PATH off Windows", () => {
    // Act
    const bash = findBash("linux", null, () => false);

    // Assert
    expect(bash).toBe("bash");
  });

  test("should find Git's bash next to git in cmd on Windows", () => {
    // Act
    const bash = findBash(
      "win32",
      `${GIT_ROOT}\\cmd\\git.exe`,
      (path) => path === GIT_BASH,
    );

    // Assert
    expect(bash).toBe(GIT_BASH);
  });

  test("should find Git's bash from git in mingw64 bin on Windows", () => {
    // Act
    const bash = findBash(
      "win32",
      `${GIT_ROOT}\\mingw64\\bin\\git.exe`,
      (path) => path === GIT_BASH,
    );

    // Assert
    expect(bash).toBe(GIT_BASH);
  });

  test("should find no bash on Windows without git", () => {
    // Act
    const bash = findBash("win32", null, () => true);

    // Assert
    expect(bash).toBeUndefined();
  });

  test("should find no bash on Windows when Git has no bash.exe", () => {
    // Act
    const bash = findBash("win32", `${GIT_ROOT}\\cmd\\git.exe`, () => false);

    // Assert
    expect(bash).toBeUndefined();
  });
});

/** The real scan script, run with a stub `grep` first on PATH. */
const REAL_SCAN = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "ci",
  "leak-scan.sh",
);

/** Grep's `-n` lines for a Windows drive path, as Git Bash prints them for a
 * preview's temp folder: the root as given, then `/`. */
const DRIVE_EXTENSION_HIT =
  "C:\\t\\dotfiles/linux/gnome/dconf/shell.ini:2:enabled-extensions=['clipboard-history@example.github.io']";
const DRIVE_ADDRESS_HIT =
  "C:\\t\\dotfiles/common/x.txt:3:mail=someone@example.org";
const DRIVE_ADDRESS_REPORT = "C:\\t\\dotfiles/common/x.txt:3: email";

/** Runs the real script on an existing folder; the stub grep prints `hits`
 * for the email rule's pattern (the one holding `@`) and finds nothing else. */
function scanWithGrepHits(hits: string): { code: number; stdout: string } {
  const bin = tempFolder();
  const out = join(bin, "hits.txt");
  writeFileSync(out, `${hits}\n`);
  writeFileSync(
    join(bin, "grep"),
    `#!/usr/bin/env bash\ncase "$3" in *@*) cat '${out}'; exit 0 ;; esac\nexit 1\n`,
  );
  chmodSync(join(bin, "grep"), 0o755);
  const result = Bun.spawnSync({
    cmd: ["bash", REAL_SCAN, tempFolder()],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

describe("leak-scan.sh on Windows drive paths", () => {
  test("should allow an extension UUID in a dconf ini when the path has a drive", () => {
    // Act
    const result = scanWithGrepHits(DRIVE_EXTENSION_HIT);

    // Assert
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("should report a drive path hit with its file and line number", () => {
    // Act
    const result = scanWithGrepHits(DRIVE_ADDRESS_HIT);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n")[0]).toBe(DRIVE_ADDRESS_REPORT);
  });
});
