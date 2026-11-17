import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, ConfigV2Entry, Os } from "../core/config/types.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { planImport } from "../core/plan/import.ts";
import type {
  Action,
  FileStep,
  RunPlan,
  Snapshot,
  StepAction,
} from "../core/plan/types.ts";
import { readSnapshot, runPlan } from "./fs.ts";
import type { RunContext } from "./fs.ts";
import { expandHome, homeFolder, stateFolder } from "./paths.ts";
import type { StoreLocation } from "./store.ts";

const FILE_MODE = 0o644;

const PRIVATE_MODE = 0o600;

const BACKUP_MODE = 0o640;

const FOLDER_MODE = 0o755;

/** A file mode the test can't read, for the unreadable kind (skipped as root). */
const UNREADABLE_MODE = 0o000;

/** A local time, so the dated backup's name is the same in every time zone. */
const RUN_TIME = new Date(2026, 1, 3, 4, 5, 6);

const RUN_PID = 4242;

const RUN_NAME = "20260203-040506-4242";

/** A later local time, so the second run's folder differs from the first's. */
const SECOND_RUN_TIME = new Date(2026, 1, 3, 4, 5, 7);

const SECOND_RUN_NAME = "20260203-040507-4242";

const KEPT_BACKUP_RUNS = 20;

/** The dconf folder an import loads into. */
const DCONF_PATH = "/org/gnome/shell/";

/** The text a dconf load receives on stdin. */
const DCONF_TEXT = "[org/gnome/shell]\n";

/** A variable only the context's environment sets, so the stub proves it saw it. */
const ENV_MARKER = "context-env";

/** `sh` lives here; the stub folder is the only other PATH entry. */
const SYSTEM_PATH = "/usr/bin:/bin";

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-fs-"));
  tempFolders.push(folder);
  return folder;
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
}

/** A throwaway repo and a `/home/user`-style home, never the real one. */
function fixture(): Fixture {
  const root = tempFolder();
  const home = join(root, "home", "user");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true, mode: FOLDER_MODE });
  mkdirSync(repo, { recursive: true, mode: FOLDER_MODE });
  return { home, repo };
}

function writeFixture(path: string, text: string, mode = FILE_MODE): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** Write an executable `#!/bin/sh` stub named `name` into `bin`. */
function writeStub(bin: string, name: string, script: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function configOf(entries: readonly ConfigV2Entry[]): ConfigV2 {
  return { schemaVersion: 2, modules: {}, entries };
}

function snapshotOf(
  repo: string,
  home: string,
  entries: readonly ConfigV2Entry[],
  os: Os = "linux",
): Snapshot {
  return readSnapshot({
    repoRoot: repo,
    config: configOf(entries),
    os,
    home,
    cwd: home,
    values: {},
    env: {},
    only: [],
  });
}

/** The local store's paths, as `readStore` reports them. */
function stateStore(state: string): StoreLocation {
  return {
    recordFile: join(state, "machine.json"),
    profilesFolder: join(state, "profiles"),
    privateFiles: true,
  };
}

/** The clone's paths, as `readStore` reports them with a pointer record. */
function repoStore(repo: string): StoreLocation {
  return {
    recordFile: join(repo, "machines", "wk1-laptop.json"),
    profilesFolder: join(repo, "profiles"),
    privateFiles: false,
  };
}

function runContext(home: string, repo: string): RunContext {
  const state = stateFolder("linux", home, {});
  return {
    repoRoot: repo,
    os: "linux",
    stateFolder: state,
    location: stateStore(state),
    env: {},
    now: () => RUN_TIME,
    pid: RUN_PID,
  };
}

/** A run whose record store is the clone, as a pointer makes it. */
function repoRunContext(home: string, repo: string): RunContext {
  return {
    ...runContext(home, repo),
    location: repoStore(repo),
  };
}

function actionOf(action: Action, failure = "failed"): StepAction {
  return { action, failure };
}

function stepOf(
  actions: readonly StepAction[],
  label = "dotfiles/common/git/config",
): FileStep {
  return { label, line: 0, counted: false, actions };
}

function planOf(
  steps: readonly FileStep[],
  finish: readonly Action[] = [],
): RunPlan {
  return { steps, finish, lines: [], summary: { kind: "none" }, code: 0 };
}

function machineRecord(): MachineRecord {
  return {
    name: "wk1-laptop",
    profile: "work-1",
    os: "linux",
    hostname: "wk1-laptop",
    domain: null,
    claude: "claude",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: { "<HOME>": "/home/user" },
    replaced: [],
    retired: false,
  };
}

function workProfile(): Profile {
  return {
    name: "work-1",
    modules: ["shell"],
    values: { "<YOUR_NAME>": "Parity User" },
    destinations: {},
    retired: false,
  };
}

function localFileEntry(localPath: string, file = "git/config"): ConfigV2Entry {
  return { file, module: "shell", merge: "whole", localPath };
}

function directoryEntry(localPath: string, file = "code/User"): ConfigV2Entry {
  return { file, module: "shell", merge: "dir", localPath };
}

describe("readSnapshot", () => {
  test("should read the local file a file entry names", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "name = repo\n");
    const localFile = join(home, ".config", "git", "config");
    writeFixture(localFile, "name = user\n", PRIVATE_MODE);

    // Act
    const snapshot = snapshotOf(repo, home, [
      localFileEntry("~/.config/git/config"),
    ]);

    // Assert
    expect(
      textOf(
        snapshot.repoFiles.get("dotfiles/common/git/config") ??
          new Uint8Array(),
      ),
    ).toBe("name = repo\n");
    const local = snapshot.localFiles.get(localFile);
    expect(local?.kind).toBe("file");
    if (local?.kind !== "file") {
      throw new Error("the local file entry was not read");
    }
    expect(textOf(local.bytes)).toBe("name = user\n");
    expect(local.mode).toBe(PRIVATE_MODE);
    expect(snapshot.head).toBeUndefined();
    expect(snapshot.headFiles).toBeUndefined();
    expect(snapshot.porcelain).toBeUndefined();
  });

  test("should copy the run's profile onto the snapshot", () => {
    // Arrange
    const { home, repo } = fixture();
    const profile: Profile = {
      name: "work-1",
      modules: ["shell"],
      values: {},
      destinations: {},
      retired: false,
    };

    // Act
    const snapshot = readSnapshot({
      repoRoot: repo,
      config: configOf([]),
      os: "linux",
      profile,
      home,
      cwd: home,
      values: {},
      env: {},
      only: [],
    });

    // Assert
    expect(snapshot.profile).toBe(profile);
  });

  test("should read an import entry's side file for a later layer", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "common", "claude", "CLAUDE.md"),
      "base\n",
    );
    writeFixture(
      join(repo, "dotfiles", "linux", "claude", "CLAUDE.md"),
      "os\n",
    );
    const sideFile = join(home, ".claude", "CLAUDE.linux.md");
    writeFixture(sideFile, "os edited\n");
    const entry: ConfigV2Entry = {
      file: "claude/CLAUDE.md",
      module: "shell",
      merge: "import",
      localPath: "~/.claude/CLAUDE.md",
      importName: "CLAUDE.{layer}.md",
    };

    // Act
    const snapshot = snapshotOf(repo, home, [entry]);

    // Assert
    const side = snapshot.localFiles.get(sideFile);
    if (side?.kind !== "file") {
      throw new Error("the import side file was not read");
    }
    expect(textOf(side.bytes)).toBe("os edited\n");
  });

  test("should read a file entry's local path through a symlink", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "common", "git", "config"),
      "name = repo\n",
    );
    const target = join(home, ".config", "git", "config.real");
    writeFixture(target, "name = user\n", PRIVATE_MODE);
    const localFile = join(home, ".config", "git", "config");
    symlinkSync(target, localFile);

    // Act
    const snapshot = snapshotOf(repo, home, [
      localFileEntry("~/.config/git/config"),
    ]);

    // Assert
    const local = snapshot.localFiles.get(localFile);
    expect(local?.kind).toBe("file");
    if (local?.kind !== "file") {
      throw new Error("the local file entry was not read through the link");
    }
    expect(textOf(local.bytes)).toBe("name = user\n");
    expect(local.mode).toBe(PRIVATE_MODE);
    expect(lstatSync(localFile).isSymbolicLink()).toBe(true);
  });

  test("should leave a dangling link at a file entry out", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(join(repo, "dotfiles", "common", "git", "config"), "x\n");
    const localFile = join(home, ".config", "git", "config");
    mkdirSync(dirname(localFile), { recursive: true });
    symlinkSync(join(home, ".config", "git", "missing"), localFile);

    // Act
    const snapshot = snapshotOf(repo, home, [
      localFileEntry("~/.config/git/config"),
    ]);

    // Assert
    expect(snapshot.localFiles.has(localFile)).toBe(false);
    expect(snapshot.localDirs.has(dirname(localFile))).toBe(false);
  });

  test("should recurse a dir entry and record a symlink without following it", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "common", "code", "User", "settings.json"),
      "{}\n",
    );
    const localDir = join(home, ".config", "Code", "User");
    writeFixture(join(localDir, "settings.json"), "{}\n");
    writeFixture(join(localDir, "snippets", "git.json"), "{}\n");
    const link = join(localDir, "link.json");
    symlinkSync(join(localDir, "settings.json"), link);

    // Act
    const snapshot = snapshotOf(repo, home, [
      directoryEntry("~/.config/Code/User"),
    ]);

    // Assert
    expect(snapshot.localFiles.get(join(localDir, "settings.json"))?.kind).toBe(
      "file",
    );
    expect(
      snapshot.localFiles.get(join(localDir, "snippets", "git.json"))?.kind,
    ).toBe("file");
    expect(snapshot.localFiles.get(link)?.kind).toBe("symlink");
    expect(snapshot.localDirs.has(localDir)).toBe(true);
    expect(snapshot.localDirs.has(join(localDir, "snippets"))).toBe(true);
  });

  test("should read a dir entry whose local folder is a symlink to a folder", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "common", "code", "User", "settings.json"),
      "{}\n",
    );
    const realDir = join(home, ".config", "Code", "User.real");
    writeFixture(join(realDir, "settings.json"), "{}\n");
    const localDir = join(home, ".config", "Code", "User");
    symlinkSync(realDir, localDir);

    // Act
    const snapshot = snapshotOf(repo, home, [
      directoryEntry("~/.config/Code/User"),
    ]);

    // Assert
    expect(snapshot.localFiles.get(join(localDir, "settings.json"))?.kind).toBe(
      "file",
    );
    expect(snapshot.localFiles.has(localDir)).toBe(false);
    expect(snapshot.localDirs.has(localDir)).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)(
    "should record a local file it cannot read as the unreadable kind",
    () => {
      // Arrange
      const { home, repo } = fixture();
      writeFixture(join(repo, "dotfiles", "common", "git", "config"), "x\n");
      const localFile = join(home, ".config", "git", "config");
      writeFixture(localFile, "name = user\n", UNREADABLE_MODE);

      // Act
      const snapshot = snapshotOf(repo, home, [
        localFileEntry("~/.config/git/config"),
      ]);

      // Assert
      expect(snapshot.localFiles.get(localFile)?.kind).toBe("unreadable");
      expect(snapshot.localDirs.has(dirname(localFile))).toBe(true);
    },
  );

  test("should leave a missing local file out", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(join(repo, "dotfiles", "common", "git", "config"), "x\n");
    const localFile = join(home, ".config", "git", "config");

    // Act
    const snapshot = snapshotOf(repo, home, [
      localFileEntry("~/.config/git/config"),
    ]);

    // Assert
    expect(snapshot.localFiles.has(localFile)).toBe(false);
    expect(snapshot.localDirs.has(dirname(localFile))).toBe(false);
  });

  test("should read every file under dotfiles for the orphan report", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "linux", "shell", "bashrc"),
      "export A=1\n",
    );
    writeFixture(
      join(repo, "dotfiles", "windows", "shell", "profile.ps1"),
      "#\n",
    );
    writeFixture(join(repo, "sync-config.json"), "{}\n");

    // Act
    const snapshot = snapshotOf(repo, home, []);

    // Assert
    expect([...snapshot.repoFiles.keys()].sort()).toEqual([
      "dotfiles/linux/shell/bashrc",
      "dotfiles/windows/shell/profile.ps1",
    ]);
  });
});

describe("runPlan", () => {
  test("should write a repo file, creating its folder first", () => {
    // Arrange
    const { home, repo } = fixture();
    const plan = planOf([
      stepOf([
        actionOf({ kind: "mkdir", path: "dotfiles/linux/shell" }),
        actionOf({
          kind: "writeRepo",
          path: "dotfiles/linux/shell/bashrc",
          bytes: bytesOf("export A=1\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(
      readFileSync(join(repo, "dotfiles", "linux", "shell", "bashrc"), "utf8"),
    ).toBe("export A=1\n");
  });

  test("should run a dconf load with the context's environment", () => {
    // Arrange
    const { home, repo } = fixture();
    const bin = tempFolder();
    const argsFile = join(tempFolder(), "args");
    const markerFile = join(tempFolder(), "marker");
    writeStub(
      bin,
      "dconf",
      `cat > /dev/null\nprintf '%s\\n' "$*" > '${argsFile}'\nprintf '%s' "$MKSYNC_TEST_MARKER" > '${markerFile}'`,
    );
    const plan = planOf([
      stepOf([
        actionOf(
          { kind: "dconfLoad", path: DCONF_PATH, text: DCONF_TEXT },
          "dconf load failed",
        ),
      ]),
    ]);
    const context: RunContext = {
      ...runContext(home, repo),
      env: {
        PATH: `${bin}:${SYSTEM_PATH}`,
        MKSYNC_TEST_MARKER: ENV_MARKER,
      },
    };

    // Act
    const outcome = runPlan(plan, context);

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(readFileSync(argsFile, "utf8").trim()).toBe(`load ${DCONF_PATH}`);
    expect(readFileSync(markerFile, "utf8")).toBe(ENV_MARKER);
  });

  test("should write a profile layer file under the state folder", () => {
    // Arrange
    const { home, repo } = fixture();
    const plan = planOf([
      stepOf([
        actionOf({ kind: "mkdir", path: "profiles/work-1" }),
        actionOf({
          kind: "writeRepo",
          path: "profiles/work-1/x.json",
          bytes: bytesOf('{"a":3}\n'),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(
      readFileSync(
        join(stateFolder("linux", home, {}), "profiles", "work-1", "x.json"),
        "utf8",
      ),
    ).toBe('{"a":3}\n');
    expect(existsSync(join(repo, "profiles", "work-1", "x.json"))).toBe(false);
  });

  test("should resolve machine and profile layer writes under the clone with a pointer", () => {
    // Arrange
    const { home, repo } = fixture();
    const plan = planOf([
      stepOf([
        actionOf({ kind: "mkdir", path: "machines/wk1-laptop/parity" }),
        actionOf({
          kind: "writeRepo",
          path: "machines/wk1-laptop/parity/settings.json",
          bytes: bytesOf('{"machine":1}\n'),
        }),
        actionOf({ kind: "mkdir", path: "profiles/work-1/parity" }),
        actionOf({
          kind: "writeRepo",
          path: "profiles/work-1/parity/settings.json",
          bytes: bytesOf('{"profile":1}\n'),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, repoRunContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(
      readFileSync(
        join(repo, "machines", "wk1-laptop", "parity", "settings.json"),
        "utf8",
      ),
    ).toBe('{"machine":1}\n');
    expect(
      readFileSync(
        join(repo, "profiles", "work-1", "parity", "settings.json"),
        "utf8",
      ),
    ).toBe('{"profile":1}\n');
    const state = stateFolder("linux", home, {});
    expect(existsSync(join(state, "machines"))).toBe(false);
    expect(existsSync(join(state, "profiles"))).toBe(false);
  });

  test("should resolve machine and profile layer writes under the state folder with a local store", () => {
    // Arrange
    const { home, repo } = fixture();
    const state = stateFolder("linux", home, {});
    const plan = planOf([
      stepOf([
        actionOf({ kind: "mkdir", path: "machines/wk1-laptop/parity" }),
        actionOf({
          kind: "writeRepo",
          path: "machines/wk1-laptop/parity/settings.json",
          bytes: bytesOf('{"machine":1}\n'),
        }),
        actionOf({ kind: "mkdir", path: "profiles/work-1/parity" }),
        actionOf({
          kind: "writeRepo",
          path: "profiles/work-1/parity/settings.json",
          bytes: bytesOf('{"profile":1}\n'),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(
      readFileSync(
        join(state, "machines", "wk1-laptop", "parity", "settings.json"),
        "utf8",
      ),
    ).toBe('{"machine":1}\n');
    expect(
      readFileSync(
        join(state, "profiles", "work-1", "parity", "settings.json"),
        "utf8",
      ),
    ).toBe('{"profile":1}\n');
    expect(existsSync(join(repo, "machines"))).toBe(false);
    expect(existsSync(join(repo, "profiles"))).toBe(false);
  });

  test("should keep the old state file in the run folder before overwriting it", () => {
    // Arrange
    const { home, repo } = fixture();
    const state = stateFolder("linux", home, {});
    const stateFile = join(state, "profiles", "work-1", "x.json");
    writeFixture(stateFile, '{"a":1}\n');
    const runFolder = join(state, "backups", RUN_NAME);
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "writeRepo",
          path: "profiles/work-1/x.json",
          bytes: bytesOf('{"a":2}\n'),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.backups).toBe(runFolder);
    expect(
      readFileSync(join(runFolder, "profiles", "work-1", "x.json"), "utf8"),
    ).toBe('{"a":1}\n');
    expect(readFileSync(stateFile, "utf8")).toBe('{"a":2}\n');
  });

  test("should fail a state path that resolves outside the state folder", () => {
    // Arrange
    const { home, repo } = fixture();
    const state = stateFolder("linux", home, {});
    // The state folder exists, so only the containment check can stop the write.
    mkdirSync(join(state, "profiles", "work-1"), { recursive: true });
    const plan = planOf([
      stepOf([
        actionOf(
          {
            kind: "writeRepo",
            path: "profiles/work-1/../../x",
            bytes: bytesOf("x\n"),
          },
          "cannot write a path outside the state folder",
        ),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.get(0)).toBe(
      "cannot write a path outside the state folder",
    );
    expect(existsSync(join(state, "x"))).toBe(false);
    expect(existsSync(join(state, "backups"))).toBe(false);
    expect(existsSync(join(repo, "x"))).toBe(false);
  });

  test("should fail a state path that leaves its profile layer", () => {
    // Arrange
    const { home, repo } = fixture();
    const state = stateFolder("linux", home, {});
    // The state folder and the target profile exist, so only containment can stop the write.
    mkdirSync(join(state, "profiles", "work-2"), { recursive: true });
    const plan = planOf([
      stepOf([
        actionOf(
          {
            kind: "writeRepo",
            path: "profiles/work-1/../work-2/f",
            bytes: bytesOf("x\n"),
          },
          "cannot write outside a profile's layer folder",
        ),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.get(0)).toBe(
      "cannot write outside a profile's layer folder",
    );
    expect(existsSync(join(state, "profiles", "work-2", "f"))).toBe(false);
    expect(existsSync(join(state, "backups"))).toBe(false);
    expect(existsSync(join(repo, "profiles", "work-2", "f"))).toBe(false);
  });

  test("should fail a repo path that resolves outside the repo", () => {
    // Arrange
    const { home, repo } = fixture();
    const plan = planOf([
      stepOf([
        actionOf(
          {
            kind: "writeRepo",
            path: "dotfiles/../../x",
            bytes: bytesOf("x\n"),
          },
          "cannot write a path outside the repo",
        ),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.get(0)).toBe("cannot write a path outside the repo");
    expect(existsSync(join(repo, "..", "x"))).toBe(false);
  });

  test("should make no backup folder when a state write creates a new file", () => {
    // Arrange
    const { home, repo } = fixture();
    const state = stateFolder("linux", home, {});
    const plan = planOf([
      stepOf([
        actionOf({ kind: "mkdir", path: "profiles/work-1" }),
        actionOf({
          kind: "writeRepo",
          path: "profiles/work-1/new.json",
          bytes: bytesOf('{"b":1}\n'),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.backups).toBeUndefined();
    expect(existsSync(join(state, "backups"))).toBe(false);
    expect(
      readFileSync(join(state, "profiles", "work-1", "new.json"), "utf8"),
    ).toBe('{"b":1}\n');
  });

  test("should remove a repo file", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "x\n");
    const plan = planOf([
      stepOf([
        actionOf({ kind: "removeRepo", path: "dotfiles/common/git/config" }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(existsSync(repoFile)).toBe(false);
  });

  test("should prune every folder a removed repo file empties", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoDir = join(repo, "dotfiles", "common", "parity", "dir");
    const repoFile = join(repoDir, "a", "b", "c.txt");
    writeFixture(repoFile, "x\n");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "removeRepo",
          path: "dotfiles/common/parity/dir/a/b/c.txt",
          pruneUpTo: "dotfiles/common/parity/dir",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(existsSync(repoFile)).toBe(false);
    expect(existsSync(join(repoDir, "a", "b"))).toBe(false);
    expect(existsSync(join(repoDir, "a"))).toBe(false);
  });

  test("should keep a pruned file's parent folder that still holds a file", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoDir = join(repo, "dotfiles", "common", "parity", "dir");
    const repoFile = join(repoDir, "a", "b", "c.txt");
    const keptFile = join(repoDir, "a", "keep.txt");
    writeFixture(repoFile, "x\n");
    writeFixture(keptFile, "y\n");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "removeRepo",
          path: "dotfiles/common/parity/dir/a/b/c.txt",
          pruneUpTo: "dotfiles/common/parity/dir",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(existsSync(join(repoDir, "a", "b"))).toBe(false);
    expect(existsSync(keptFile)).toBe(true);
  });

  test("should keep the entry's own folder when pruning leaves it empty", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoDir = join(repo, "dotfiles", "common", "parity", "dir");
    const repoFile = join(repoDir, "c.txt");
    writeFixture(repoFile, "x\n");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "removeRepo",
          path: "dotfiles/common/parity/dir/c.txt",
          pruneUpTo: "dotfiles/common/parity/dir",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(existsSync(repoFile)).toBe(false);
    expect(existsSync(repoDir)).toBe(true);
  });

  test("should remove only the file when no prune folder is set", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoDir = join(repo, "dotfiles", "common", "parity", "dir");
    const repoFile = join(repoDir, "a", "b", "c.txt");
    writeFixture(repoFile, "x\n");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "removeRepo",
          path: "dotfiles/common/parity/dir/a/b/c.txt",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(existsSync(repoFile)).toBe(false);
    expect(existsSync(join(repoDir, "a", "b"))).toBe(true);
  });

  test("should write a local file named by an absolute path", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "writeLocal",
          path: localFile,
          bytes: bytesOf("name = user\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(readFileSync(localFile, "utf8")).toBe("name = user\n");
  });

  test("should write through a local symlink and back up its target", () => {
    // Arrange
    const { home, repo } = fixture();
    const target = join(home, ".config", "git", "config.real");
    writeFixture(target, "old\n");
    const localFile = join(home, ".config", "git", "config");
    symlinkSync(target, localFile);
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "backup",
          path: localFile,
          repoPath: "dotfiles/common/git/config",
        }),
        actionOf({
          kind: "writeLocal",
          path: localFile,
          bytes: bytesOf("new\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("new\n");
    expect(lstatSync(localFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${localFile}.bak`, "utf8")).toBe("old\n");
  });

  test("should keep an existing target's mode when writing", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "old\n", PRIVATE_MODE);
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "writeRepo",
          path: "dotfiles/common/git/config",
          bytes: bytesOf("new\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(readFileSync(repoFile, "utf8")).toBe("new\n");
    expect(statSync(repoFile).mode & 0o7777).toBe(PRIVATE_MODE);
  });

  test("should copy a backup with its mode and times, replacing an older one", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    writeFixture(localFile, "old\n", BACKUP_MODE);
    const when = new Date("2026-01-02T03:04:05Z");
    utimesSync(localFile, when, when);
    const source = statSync(localFile);
    const backup = `${localFile}.bak`;
    writeFixture(backup, "older\n", PRIVATE_MODE);
    const plan = planOf([
      stepOf([actionOf({ kind: "backup", path: localFile })]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(readFileSync(backup, "utf8")).toBe("old\n");
    expect(statSync(backup).mode & 0o7777).toBe(BACKUP_MODE);
    expect(statSync(backup).mtime.getTime()).toBe(source.mtime.getTime());
  });

  test("should create a folder and its parents", () => {
    // Arrange
    const { home, repo } = fixture();
    const folder = join(home, ".local", "state", "sync-settings");
    const plan = planOf([stepOf([actionOf({ kind: "mkdir", path: folder })])]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(statSync(folder).isDirectory()).toBe(true);
  });

  test("should set a mode on a repo file", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "x\n", FILE_MODE);
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "chmod",
          path: "dotfiles/common/git/config",
          mode: PRIVATE_MODE,
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(statSync(repoFile).mode & 0o7777).toBe(PRIVATE_MODE);
  });

  test("should write the state file and create its folder", () => {
    // Arrange
    const { home, repo } = fixture();
    const stateFile = join(
      home,
      ".local",
      "state",
      "sync-settings",
      "last-sync",
    );
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "writeState",
          path: stateFile,
          text: "0123456789abcdef\n",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(readFileSync(stateFile, "utf8")).toBe("0123456789abcdef\n");
  });

  test("should record a failing action's reason and run the next step", () => {
    // Arrange
    const { home, repo } = fixture();
    const blocked = join(home, "blocked");
    mkdirSync(blocked);
    const later = join(home, "later.txt");
    const plan = planOf([
      stepOf([
        actionOf(
          { kind: "writeLocal", path: blocked, bytes: bytesOf("x\n") },
          "cannot write local file",
        ),
      ]),
      stepOf([
        actionOf({
          kind: "writeLocal",
          path: later,
          bytes: bytesOf("later\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.get(0)).toBe("cannot write local file");
    expect(outcome.failed.size).toBe(1);
    expect(readFileSync(later, "utf8")).toBe("later\n");
  });

  test("should stop a step at a failed .bak and run the next step", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    writeFixture(localFile, "old\n");
    mkdirSync(`${localFile}.bak`);
    const next = join(home, "next.txt");
    const plan = planOf([
      stepOf([
        actionOf(
          {
            kind: "backup",
            path: localFile,
            repoPath: "dotfiles/common/git/config",
          },
          "cannot create backup",
        ),
        actionOf(
          { kind: "writeLocal", path: localFile, bytes: bytesOf("new\n") },
          "cannot write local file",
        ),
      ]),
      stepOf([
        actionOf({ kind: "writeLocal", path: next, bytes: bytesOf("next\n") }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.get(0)).toBe("cannot create backup");
    expect(outcome.failed.size).toBe(1);
    expect(outcome.backups).toBeUndefined();
    expect(readFileSync(localFile, "utf8")).toBe("old\n");
    expect(readFileSync(next, "utf8")).toBe("next\n");
  });

  test("should skip finish when a step failed", () => {
    // Arrange
    const { home, repo } = fixture();
    const blocked = join(home, "blocked");
    mkdirSync(blocked);
    const stateFile = join(home, "state", "last-sync");
    const plan = planOf(
      [
        stepOf([
          actionOf(
            { kind: "writeLocal", path: blocked, bytes: bytesOf("x\n") },
            "cannot write local file",
          ),
        ]),
      ],
      [{ kind: "writeState", path: stateFile, text: "0123456789abcdef\n" }],
    );

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(1);
    expect(existsSync(stateFile)).toBe(false);
  });

  test("should keep a dated copy under the run folder with mode and times", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    writeFixture(localFile, "old\n", BACKUP_MODE);
    const when = new Date("2026-01-02T03:04:05Z");
    utimesSync(localFile, when, when);
    const source = statSync(localFile);
    const runFolder = join(stateFolder("linux", home, {}), "backups", RUN_NAME);
    const dated = join(runFolder, "dotfiles", "common", "git", "config");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "backup",
          path: localFile,
          repoPath: "dotfiles/common/git/config",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.backups).toBe(runFolder);
    expect(readFileSync(dated, "utf8")).toBe("old\n");
    expect(statSync(dated).mode & 0o7777).toBe(BACKUP_MODE);
    expect(statSync(dated).mtime.getTime()).toBe(source.mtime.getTime());
  });

  test("should keep each import run's own dated backup folder", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "common", "git", "config"),
      "name = repo\n",
    );
    const localFile = join(home, ".config", "git", "config");
    writeFixture(localFile, "name = first\n");
    const state = stateFolder("linux", home, {});
    const firstFolder = join(state, "backups", RUN_NAME);
    const secondFolder = join(state, "backups", SECOND_RUN_NAME);
    const entries = [localFileEntry("~/.config/git/config")];
    const firstPlan = planImport(snapshotOf(repo, home, entries), []);
    runPlan(firstPlan, runContext(home, repo));
    writeFixture(localFile, "name = second\n");
    const secondPlan = planImport(snapshotOf(repo, home, entries), []);

    // Act
    const outcome = runPlan(secondPlan, {
      ...runContext(home, repo),
      now: () => SECOND_RUN_TIME,
    });

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.backups).toBe(secondFolder);
    expect(readdirSync(join(state, "backups")).sort()).toEqual([
      RUN_NAME,
      SECOND_RUN_NAME,
    ]);
    expect(
      readFileSync(
        join(firstFolder, "dotfiles", "common", "git", "config"),
        "utf8",
      ),
    ).toBe("name = first\n");
    expect(
      readFileSync(
        join(secondFolder, "dotfiles", "common", "git", "config"),
        "utf8",
      ),
    ).toBe("name = second\n");
    expect(readFileSync(localFile, "utf8")).toBe("name = repo\n");
  });

  test("should make no backup folder when an import changes nothing", () => {
    // Arrange
    const { home, repo } = fixture();
    writeFixture(
      join(repo, "dotfiles", "common", "git", "config"),
      "name = same\n",
    );
    const localFile = join(home, ".config", "git", "config");
    writeFixture(localFile, "name = same\n");
    const state = stateFolder("linux", home, {});
    const plan = planImport(
      snapshotOf(repo, home, [localFileEntry("~/.config/git/config")]),
      [],
    );

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.backups).toBeUndefined();
    expect(existsSync(join(state, "backups"))).toBe(false);
    expect(readFileSync(localFile, "utf8")).toBe("name = same\n");
  });

  test("should warn and keep writing when the dated copy fails", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    writeFixture(localFile, "old\n");
    const state = stateFolder("linux", home, {});
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "backups"), "blocked\n");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "backup",
          path: localFile,
          repoPath: "dotfiles/common/git/config",
        }),
        actionOf({
          kind: "writeLocal",
          path: localFile,
          bytes: bytesOf("new\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.warnings.get(0)).toEqual([
      "  WARNING: could not keep a dated backup of dotfiles/common/git/config.",
    ]);
    expect(outcome.backups).toBeUndefined();
    expect(readFileSync(localFile, "utf8")).toBe("new\n");
  });

  test("should warn and keep writing when a dated copy's repo path escapes the run folder", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    writeFixture(localFile, "old\n");
    const state = stateFolder("linux", home, {});
    const repoPath = "dotfiles/../../x";
    const plan = planOf([
      stepOf([
        actionOf({ kind: "backup", path: localFile, repoPath }),
        actionOf({
          kind: "writeLocal",
          path: localFile,
          bytes: bytesOf("new\n"),
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(outcome.warnings.get(0)).toEqual([
      `  WARNING: could not keep a dated backup of ${repoPath}.`,
    ]);
    expect(outcome.backups).toBeUndefined();
    expect(readFileSync(localFile, "utf8")).toBe("new\n");
    expect(existsSync(join(state, "backups", "x"))).toBe(false);
    expect(existsSync(join(state, "backups", RUN_NAME))).toBe(false);
  });

  test("should keep only the newest 20 run folders", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");
    writeFixture(localFile, "old\n");
    const backups = join(stateFolder("linux", home, {}), "backups");
    const olderRuns = Array.from(
      { length: KEPT_BACKUP_RUNS },
      (_, index) => `202601${String(index + 1).padStart(2, "0")}-000000-1`,
    );
    for (const name of olderRuns) {
      mkdirSync(join(backups, name), { recursive: true });
    }
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "backup",
          path: localFile,
          repoPath: "dotfiles/common/git/config",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    const kept = readdirSync(backups).sort();
    expect(kept).toHaveLength(KEPT_BACKUP_RUNS);
    expect(kept).not.toContain(olderRuns[0]);
    expect(kept).toContain(RUN_NAME);
  });

  test("should copy the repo file's mode when creating a local file", () => {
    // Arrange
    const { home, repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "name = repo\n", PRIVATE_MODE);
    const localFile = join(home, ".gitconfig");
    const plan = planOf([
      stepOf([
        actionOf({
          kind: "writeLocal",
          path: localFile,
          bytes: bytesOf("name = repo\n"),
          modeFrom: "dotfiles/common/git/config",
        }),
      ]),
    ]);

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(statSync(localFile).mode & 0o7777).toBe(PRIVATE_MODE);
  });
});

describe("paths", () => {
  test("should expand ~/ against the home folder", () => {
    // Act
    const expanded = expandHome("~/.config/git/ignore", "linux", "/home/user");

    // Assert
    expect(expanded).toBe("/home/user/.config/git/ignore");
  });

  test("should turn / into \\ on Windows", () => {
    // Act
    const expanded = expandHome(
      "~/.config/git/ignore",
      "windows",
      "C:\\Users\\user",
    );

    // Assert
    expect(expanded).toBe("C:\\Users\\user\\.config\\git\\ignore");
  });

  test("should take the home folder from HOME or USERPROFILE", () => {
    // Act
    const linux = homeFolder("linux", { HOME: "/home/user" });
    const windows = homeFolder("windows", { USERPROFILE: "C:\\Users\\user" });

    // Assert
    expect(linux).toBe("/home/user");
    expect(windows).toBe("C:\\Users\\user");
  });

  test("should name the sync point's state folder per OS", () => {
    // Act
    const linux = stateFolder("linux", "/home/user", {});
    const xdg = stateFolder("linux", "/home/user", {
      XDG_STATE_HOME: "/state",
    });
    const windows = stateFolder("windows", "C:\\Users\\user", {
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
    });

    // Assert
    expect(linux).toBe("/home/user/.local/state/sync-settings");
    expect(xdg).toBe("/state/sync-settings");
    expect(windows).toBe("C:\\Users\\user\\AppData\\Local\\SyncSettings");
  });
});

describe("runPlan values file", () => {
  test("should write .user-values.json in the repo readable by the user only", () => {
    // Arrange
    const { home, repo } = fixture();
    const text = '{\n  "<YOUR_NAME>": "Parity User"\n}\n';
    const plan: RunPlan = {
      ...planOf([]),
      prepare: [{ kind: "writeValues", text }],
    };

    // Act
    runPlan(plan, runContext(home, repo));

    // Assert
    const path = join(repo, ".user-values.json");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(PRIVATE_MODE);
  });

  test("should tighten an existing readable values file", () => {
    // Arrange
    const { home, repo } = fixture();
    const path = join(repo, ".user-values.json");
    writeFixture(path, "{}\n", FILE_MODE);
    const plan: RunPlan = {
      ...planOf([]),
      prepare: [{ kind: "writeValues", text: "{}\n" }],
    };

    // Act
    runPlan(plan, runContext(home, repo));

    // Assert
    expect(statSync(path).mode & 0o777).toBe(PRIVATE_MODE);
  });
});

describe("runPlan machine values", () => {
  test("should write the record and profile with their merged values", () => {
    // Arrange
    const { home, repo } = fixture();
    const record: MachineRecord = {
      name: "wk1-laptop",
      profile: "work-1",
      os: "linux",
      hostname: "wk1-laptop",
      domain: null,
      claude: "claude",
      pullOnly: false,
      modules: { add: [], remove: [] },
      values: { "<HOME>": "/home/user" },
      replaced: [],
      retired: false,
    };
    const profile: Profile = {
      name: "work-1",
      modules: ["shell"],
      values: { "<YOUR_NAME>": "Parity User" },
      destinations: {},
      retired: false,
    };
    const plan: RunPlan = {
      ...planOf([]),
      prepare: [{ kind: "writeMachineValues", record, profile }],
    };

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    const state = stateFolder("linux", home, {});
    const machinePath = join(state, "machine.json");
    const profilePath = join(state, "profiles", "work-1.json");
    expect(readFileSync(machinePath, "utf8")).toContain(
      '"<HOME>": "/home/user"',
    );
    expect(readFileSync(profilePath, "utf8")).toContain(
      '"<YOUR_NAME>": "Parity User"',
    );
    expect(statSync(machinePath).mode & 0o777).toBe(PRIVATE_MODE);
    expect(statSync(profilePath).mode & 0o777).toBe(PRIVATE_MODE);
  });

  test("should write the record and profile under the clone with a pointer", () => {
    // Arrange
    const { home, repo } = fixture();
    const plan: RunPlan = {
      ...planOf([]),
      prepare: [
        {
          kind: "writeMachineValues",
          record: machineRecord(),
          profile: workProfile(),
        },
      ],
    };

    // Act
    const outcome = runPlan(plan, repoRunContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    expect(
      readFileSync(join(repo, "machines", "wk1-laptop.json"), "utf8"),
    ).toContain('"<HOME>": "/home/user"');
    expect(
      readFileSync(join(repo, "profiles", "work-1.json"), "utf8"),
    ).toContain('"<YOUR_NAME>": "Parity User"');
    const state = stateFolder("linux", home, {});
    expect(existsSync(join(state, "machine.json"))).toBe(false);
    expect(existsSync(join(state, "profiles", "work-1.json"))).toBe(false);
  });

  test("should write the record and profile under the state folder with a local store", () => {
    // Arrange
    const { home, repo } = fixture();
    const plan: RunPlan = {
      ...planOf([]),
      prepare: [
        {
          kind: "writeMachineValues",
          record: machineRecord(),
          profile: workProfile(),
        },
      ],
    };

    // Act
    const outcome = runPlan(plan, runContext(home, repo));

    // Assert
    expect(outcome.failed.size).toBe(0);
    const state = stateFolder("linux", home, {});
    expect(readFileSync(join(state, "machine.json"), "utf8")).toContain(
      '"<HOME>": "/home/user"',
    );
    expect(
      readFileSync(join(state, "profiles", "work-1.json"), "utf8"),
    ).toContain('"<YOUR_NAME>": "Parity User"');
    expect(existsSync(join(repo, "machines"))).toBe(false);
    expect(existsSync(join(repo, "profiles"))).toBe(false);
  });
});
