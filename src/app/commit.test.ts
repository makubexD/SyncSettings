import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreLocation } from "../adapters/store.ts";
import type { CommitCommand } from "../cli/parse.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import { executeCommit } from "./commit.ts";

/** The prefix of each test's temp folder, removed after the test. */
const TEMP_PREFIX = "mksync-commit-";

/** The real scan `commit.sh` runs, copied into the fixture repo so the
 * fixture needs neither the project's scripts nor its own stub. */
const LEAK_SCAN_SOURCE = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "ci",
  "leak-scan.sh",
);

const LEAK_SCAN = join("scripts", "ci", "leak-scan.sh");

/** The config file the leak scan requires to exist. */
const CONFIG_FILE = "sync-config.json";

/** A minimal v2 config: no modules and no entries, since commit reads the
 * checks' paths from the clone, not from entries. */
const CONFIG: ConfigV2 = { schemaVersion: 2, modules: {}, entries: [] };

/** `mksync commit` with neither a message nor `--partial`. */
const COMMAND: CommitCommand = { kind: "commit", partial: false };

/** A changed file under `dotfiles/`, so commit has something to push. */
const DOTFILE = "dotfiles/linux/tool/config";

const DOTFILE_TEXT = "setting = value\n";

const MACHINE_ALIAS_KEY = "syncsettings.machine";

const MACHINE_ALIAS = "test-machine";

/** The gh name commit checks for; the fixture's own stub answers it, so the
 * test doesn't depend on the host's gh. */
const GH_ENV = "GH";

const GH_STUB = "gh-stub";

const STUB_SCRIPT = "#!/bin/sh\nexit 0\n";

const EXECUTABLE_MODE = 0o755;

const MASTER = "master";

/** The remote-tracking ref the guard's unpushed-history read needs, created
 * without a remote so the fetch then fails the way the case wants. */
const ORIGIN_MASTER_REF = "refs/remotes/origin/master";

const GIT_CONFIG_NOSYSTEM_ENV = "GIT_CONFIG_NOSYSTEM";

const tempFolders: string[] = [];

let previousGh: string | undefined;

let previousNoSystem: string | undefined;

beforeEach(() => {
  previousGh = process.env[GH_ENV];
  previousNoSystem = process.env[GIT_CONFIG_NOSYSTEM_ENV];
  // The host's system config must not decide anything here; HOME is untouched.
  process.env[GIT_CONFIG_NOSYSTEM_ENV] = "1";
});

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  if (previousGh === undefined) {
    delete process.env[GH_ENV];
  } else {
    process.env[GH_ENV] = previousGh;
  }
  if (previousNoSystem === undefined) {
    delete process.env[GIT_CONFIG_NOSYSTEM_ENV];
  } else {
    process.env[GIT_CONFIG_NOSYSTEM_ENV] = previousNoSystem;
  }
});

/** Run one setup git command that must succeed; returns its stdout. */
function git(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/** A clone on `master` with one commit, no remote, a changed dotfile and the
 * real leak scan; returns where the run's state and gh stub live. */
function fixture(): {
  repoRoot: string;
  state: string;
  ghStub: string;
} {
  const folder = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  tempFolders.push(folder);

  const repoRoot = join(folder, "repo");
  mkdirSync(repoRoot);
  git(repoRoot, ["init", "-q", "-b", MASTER]);
  git(repoRoot, ["config", "user.name", "Test User"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", MACHINE_ALIAS_KEY, MACHINE_ALIAS]);

  writeFileSync(join(repoRoot, CONFIG_FILE), "{}\n");
  mkdirSync(join(repoRoot, "scripts", "ci"), { recursive: true });
  copyFileSync(LEAK_SCAN_SOURCE, join(repoRoot, LEAK_SCAN));
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "initial"]);

  // The guard reads origin/master..HEAD; the ref makes that range readable
  // while no remote exists, so the run reaches its fetch and fails there.
  git(repoRoot, ["update-ref", ORIGIN_MASTER_REF, "HEAD"]);

  mkdirSync(join(repoRoot, "dotfiles", "linux", "tool"), { recursive: true });
  writeFileSync(join(repoRoot, DOTFILE), DOTFILE_TEXT);

  const ghStub = join(folder, GH_STUB);
  writeFileSync(ghStub, STUB_SCRIPT, { mode: EXECUTABLE_MODE });
  chmodSync(ghStub, EXECUTABLE_MODE);
  process.env[GH_ENV] = ghStub;

  return { repoRoot, state: join(folder, "state"), ghStub };
}

function stateLocation(state: string): StoreLocation {
  return {
    recordFile: join(state, "machine.json"),
    profilesFolder: join(state, "profiles"),
    privateFiles: true,
  };
}

describe("executeCommit", () => {
  test("should print git's own fetch error and leave no branch when origin is missing", async () => {
    // Arrange
    const { repoRoot, state } = fixture();

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location: stateLocation(state),
      command: COMMAND,
    });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(result.stderr).toContain("origin");
    expect(git(repoRoot, ["branch", "--format=%(refname:short)"]).trim()).toBe(
      MASTER,
    );
  });
});
