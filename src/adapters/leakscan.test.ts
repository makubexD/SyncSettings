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
import { runLeakScan } from "./leakscan.ts";

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
    const { root } = repoWithScan(
      `printf '%s\\n' '${HIT_LINE}'\nexit 1`,
    );

    // Act
    const result = await runLeakScan(root, SYNC_PATHS);

    // Assert
    expect(result.kind).toBe("hits");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(HIT_LINE);
  });

  test("should report any other exit as could not run", async () => {
    // Arrange
    const { root } = repoWithScan(
      "printf 'ERROR: scan failed\\n' >&2\nexit 2",
    );

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
