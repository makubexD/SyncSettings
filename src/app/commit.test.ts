import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreLocation } from "../adapters/store.ts";
import { writeStoreRecord } from "../adapters/store.ts";
import type { CommitCommand } from "../cli/parse.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import type { MachineRecord } from "../core/machine/record.ts";
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
const COMMAND: CommitCommand = { kind: "commit", partial: false, yes: false };

/** A changed file under `dotfiles/`, so commit has something to push. */
const DOTFILE = "dotfiles/linux/plain.txt";

const DOTFILE_TEXT = "setting = value\n";

const MACHINE_ALIAS_KEY = "syncsettings.machine";

const MACHINE_ALIAS = "test-machine";

/** The gh name commit checks for; the fixture's own stub answers it, so the
 * test doesn't depend on the host's gh. */
const GH_ENV = "GH";

const GH_STUB = "gh-stub";

const GH_LOG = "gh.log";

const EXECUTABLE_MODE = 0o755;

/** The sync point file under the state folder (contract "Sync point"). */
const SYNC_POINT_FILE = "last-sync";

const MASTER = "master";

/** What a fixture varies: whether the leak scan is there, what gh answers and
 * whether the clone has an origin to push to. */
interface FixtureOptions {
  /** Copy the real leak scan into the clone; false leaves it unable to run. */
  readonly leakScan?: boolean;
  /** The exit code gh answers with. */
  readonly ghExitCode?: number;
  /** Give the clone an origin, a bare repo beside it, to push to. */
  readonly remote?: boolean;
}

/** The gh stub: log each call, then exit with the fixture's code. */
function ghStubScript(log: string, exitCode: number): string {
  return `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit ${exitCode}\n`;
}

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

/** A clone on `master` with one commit, a changed dotfile and the gh stub;
 * returns where the run's state and gh stub live. */
function fixture(options: FixtureOptions = {}): {
  repoRoot: string;
  state: string;
  ghStub: string;
  ghLog: string;
} {
  const { leakScan = true, ghExitCode = 0, remote = false } = options;
  const folder = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  tempFolders.push(folder);

  const repoRoot = join(folder, "repo");
  mkdirSync(repoRoot);
  git(repoRoot, ["init", "-q", "-b", MASTER]);
  git(repoRoot, ["config", "user.name", "Test User"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", MACHINE_ALIAS_KEY, MACHINE_ALIAS]);

  writeFileSync(join(repoRoot, CONFIG_FILE), "{}\n");
  if (leakScan) {
    mkdirSync(join(repoRoot, "scripts", "ci"), { recursive: true });
    copyFileSync(LEAK_SCAN_SOURCE, join(repoRoot, LEAK_SCAN));
  }
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "initial"]);

  if (remote) {
    const originRoot = join(folder, "origin.git");
    git(folder, ["init", "-q", "--bare", "-b", MASTER, originRoot]);
    git(repoRoot, ["remote", "add", "origin", originRoot]);
    git(repoRoot, ["push", "-q", "-u", "origin", MASTER]);
  } else {
    // The guard reads origin/master..HEAD; the ref makes that range readable
    // while no remote exists, so the run reaches its fetch and fails there.
    git(repoRoot, ["update-ref", ORIGIN_MASTER_REF, "HEAD"]);
  }

  mkdirSync(join(repoRoot, "dotfiles", "linux"), { recursive: true });
  writeFileSync(join(repoRoot, DOTFILE), DOTFILE_TEXT);

  const ghLog = join(folder, GH_LOG);
  const ghStub = join(folder, GH_STUB);
  writeFileSync(ghStub, ghStubScript(ghLog, ghExitCode), {
    mode: EXECUTABLE_MODE,
  });
  chmodSync(ghStub, EXECUTABLE_MODE);
  process.env[GH_ENV] = ghStub;

  return { repoRoot, state: join(folder, "state"), ghStub, ghLog };
}

function stateLocation(state: string): StoreLocation {
  return {
    recordFile: join(state, "machine.json"),
    profilesFolder: join(state, "profiles"),
    privateFiles: true,
  };
}

/** The record's name and hostname the public-name cases use. */
const RECORD_NAME = "wk1-laptop";

const RECORD_HOSTNAME = "wk1-laptop";

/** A public name the record can carry (decision 1). */
const RECORD_ALIAS = "jane-doe";

/** The public name push suggests for `machineRecord()`: `<profile>-<os>`. */
const PROFILE_ALIAS = "work-1-linux";

/** A machine record with the fixture's hostname, overridable per case. */
function machineRecord(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    name: RECORD_NAME,
    profile: "work-1",
    os: "linux",
    hostname: RECORD_HOSTNAME,
    domain: null,
    claude: "none",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: {},
    replaced: [],
    retired: false,
    ...overrides,
  };
}

/** The clone's branches, `master` first. */
function branches(repoRoot: string): string[] {
  return git(repoRoot, ["branch", "--format=%(refname:short)"])
    .split("\n")
    .filter((line) => line !== "");
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

  test("should refuse to commit on a branch other than master", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const branch = "feature";
    git(repoRoot, ["switch", "-c", branch]);

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
    expect(result.stderr).toBe(
      `ERROR: run mksync commit from master (current: ${branch}).\n`,
    );
  });

  test("should refuse to commit when the leak scan cannot run (commit-scan-missing)", async () => {
    // Arrange
    const { repoRoot, state, ghLog } = fixture({ leakScan: false });

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
    expect(result.stderr).toBe(
      "ERROR: leak scan could not run; nothing was committed.\n",
    );
    expect(existsSync(ghLog)).toBe(false);
    expect(git(repoRoot, ["branch", "--format=%(refname:short)"]).trim()).toBe(
      MASTER,
    );
  });

  test("should report the failed PR and write no sync point (sync_point_commit_pr_fails)", async () => {
    // Arrange
    const { repoRoot, state, ghLog } = fixture({
      ghExitCode: 1,
      remote: true,
    });

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
    expect(result.stderr.startsWith("ERROR: PR creation failed; branch ")).toBe(
      true,
    );
    expect(readFileSync(ghLog, "utf8").startsWith("pr create")).toBe(true);
    expect(existsSync(join(state, SYNC_POINT_FILE))).toBe(false);
  });

  test("should name the branch after the record alias when it has one", async () => {
    // Arrange
    const { repoRoot, state } = fixture({ remote: true });
    const location = stateLocation(state);
    const record = machineRecord({ alias: RECORD_ALIAS });
    writeStoreRecord(location, record);

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
    });

    // Assert
    expect(result.code).toBe(0);
    const pushed = branches(repoRoot).find((branch) =>
      branch.startsWith("sync/"),
    );
    expect(pushed ?? "").toMatch(/^sync\/linux-jane-doe-\d{8}-\d{4}$/);
    expect(pushed ?? "").not.toContain(RECORD_NAME);
  });

  test("should stop with decision 3's error when a record has no alias and no terminal", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const location = stateLocation(state);
    const record = machineRecord();
    writeStoreRecord(location, record);
    const before = readFileSync(location.recordFile, "utf8");

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
      askAlias: async () => undefined,
    });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `ERROR: machine ${RECORD_NAME} has no public name yet; run mksync push in a terminal to set one.\n`,
    );
    expect(branches(repoRoot)).toEqual([MASTER]);
    expect(readFileSync(location.recordFile, "utf8")).toBe(before);
  });

  test("should suggest <profile>-<os> and save it when the answer is empty", async () => {
    // Arrange
    const { repoRoot, state } = fixture({ remote: true });
    const location = stateLocation(state);
    const record = machineRecord();
    writeStoreRecord(location, record);
    const prompts: string[] = [];

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
      askAlias: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
    });

    // Assert
    expect(result.code).toBe(0);
    expect(prompts).toEqual([
      `  Public name for this machine's push branches [${PROFILE_ALIAS}]: `,
    ]);
    const saved = JSON.parse(readFileSync(location.recordFile, "utf8")) as {
      alias?: string;
    };
    expect(saved.alias).toBe(PROFILE_ALIAS);
    const pushed = branches(repoRoot).find((branch) =>
      branch.startsWith("sync/"),
    );
    expect(pushed ?? "").toMatch(
      new RegExp(`^sync/linux-${PROFILE_ALIAS}-\\d{8}-\\d{4}$`),
    );
  });

  test("should take the suggestion without asking when push runs with --yes", async () => {
    // Arrange
    const { repoRoot, state } = fixture({ remote: true });
    const location = stateLocation(state);
    const record = machineRecord();
    writeStoreRecord(location, record);
    const prompts: string[] = [];

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: { ...COMMAND, yes: true },
      record,
      askAlias: async (prompt) => {
        prompts.push(prompt);
        return undefined;
      },
    });

    // Assert
    expect(result.code).toBe(0);
    expect(prompts).toEqual([]);
    const saved = JSON.parse(readFileSync(location.recordFile, "utf8")) as {
      alias?: string;
    };
    expect(saved.alias).toBe(PROFILE_ALIAS);
  });

  test("should stop with the no-public-name error under --yes when the suggestion is refused", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const location = stateLocation(state);
    const record = machineRecord({ hostname: PROFILE_ALIAS });
    writeStoreRecord(location, record);
    const before = readFileSync(location.recordFile, "utf8");
    const prompts: string[] = [];

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: { ...COMMAND, yes: true },
      record,
      askAlias: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
    });

    // Assert
    expect(result.code).toBe(1);
    expect(prompts).toEqual([]);
    expect(result.stderr).toBe(
      `ERROR: machine ${RECORD_NAME} has no public name yet; run mksync push in a terminal to set one.\n`,
    );
    expect(readFileSync(location.recordFile, "utf8")).toBe(before);
  });

  test("should refuse an empty answer and write nothing when there is no suggestion", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const location = stateLocation(state);
    const record = machineRecord({ hostname: PROFILE_ALIAS });
    writeStoreRecord(location, record);
    const before = readFileSync(location.recordFile, "utf8");
    const prompts: string[] = [];

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
      askAlias: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
    });

    // Assert
    expect(result.code).toBe(1);
    expect(prompts).toEqual([
      "  Public name for this machine's push branches: ",
    ]);
    expect(result.stderr).toBe(
      "ERROR: invalid machine alias '' (use a-z, 0-9, -).\n",
    );
    expect(readFileSync(location.recordFile, "utf8")).toBe(before);
  });

  test("should refuse a stored alias that is the hostname", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const location = stateLocation(state);
    const record = { ...machineRecord(), alias: RECORD_HOSTNAME };

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
    });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `ERROR: '${RECORD_HOSTNAME}' is this machine's hostname; pick another public name.\n`,
    );
    expect(branches(repoRoot)).toEqual([MASTER]);
  });

  test("should stop with an error and commit nothing when the record can't be saved", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const location = stateLocation(state);
    const record = machineRecord();
    mkdirSync(location.recordFile, { recursive: true });

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
      askAlias: async () => "",
    });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `ERROR: could not save the public name in ${location.recordFile}; nothing was committed.\n`,
    );
    expect(branches(repoRoot)).toEqual([MASTER]);
  });

  test("should refuse the record hostname as a public name and write nothing", async () => {
    // Arrange
    const { repoRoot, state } = fixture();
    const location = stateLocation(state);
    const record = machineRecord();
    writeStoreRecord(location, record);
    const before = readFileSync(location.recordFile, "utf8");

    // Act
    const result = await executeCommit({
      repoRoot,
      config: CONFIG,
      state,
      os: "linux",
      location,
      command: COMMAND,
      record,
      askAlias: async () => record.hostname,
    });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `ERROR: '${RECORD_HOSTNAME}' is this machine's hostname; pick another public name.\n`,
    );
    expect(branches(repoRoot)).toEqual([MASTER]);
    expect(readFileSync(location.recordFile, "utf8")).toBe(before);
  });
});
