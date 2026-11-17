import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreLocation } from "../adapters/store.ts";
import type { RunCommand } from "../cli/parse.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import { runImport } from "./import.ts";
import type { RunEnvironment } from "./run.ts";

/** The prefix of each test's temp folder, removed after the test. */
const TEMP_PREFIX = "mksync-import-";

/** The variable the sync point's folder comes from (contract "Sync point"). */
const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";

/** The sync point's folder and file name under the state folder. */
const SYNC_POINT_FOLDER = "sync-settings";

const SYNC_POINT_FILE = "last-sync";

/** The repo file the fixture's one entry restores. */
const REPO_PATH = "parity/plain.txt";

const DOTFILE = join("dotfiles", "linux", "parity", "plain.txt");

const DOTFILE_TEXT = "repo text\n";

/** A minimal v2 config: one whole-file entry for the fixture's repo file. */
const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { parity: { description: "Parity fixture" } },
  entries: [
    {
      file: REPO_PATH,
      module: "parity",
      merge: "whole",
      localPath: "~/.config/parity/plain.txt",
    },
  ],
};

/** `mksync import --force`, so the run reads no answers from stdin. */
const COMMAND: RunCommand = {
  kind: "run",
  command: "import",
  force: true,
  preview: false,
  check: false,
  resetValues: false,
  yes: false,
  only: [],
};

const tempFolders: string[] = [];

let previousStateHome: string | undefined;

beforeEach(() => {
  previousStateHome = process.env[XDG_STATE_HOME_ENV];
});

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  if (previousStateHome === undefined) {
    delete process.env[XDG_STATE_HOME_ENV];
  } else {
    process.env[XDG_STATE_HOME_ENV] = previousStateHome;
  }
});

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  tempFolders.push(folder);
  return folder;
}

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

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly repo: string;
}

/** A throwaway home and a clone with one committed dotfile, never the real
 * home or the real clone. */
function fixture(): Fixture {
  const root = tempFolder();
  const home = join(root, "home", "user");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "dotfiles", "linux", "parity"), { recursive: true });
  writeFileSync(join(repo, DOTFILE), DOTFILE_TEXT);
  git(repo, ["init", "-q"]);
  git(repo, ["add", "--", "dotfiles"]);
  git(repo, [
    "-c",
    "user.name=Parity",
    "-c",
    "user.email=parity@example.test",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  return { root, home, repo };
}

/** The local store's paths, as `readStore` reports them. */
function stateStore(state: string): StoreLocation {
  return {
    recordFile: join(state, "machine.json"),
    profilesFolder: join(state, "profiles"),
    privateFiles: true,
  };
}

function runEnvironment(setup: Fixture, state: string): RunEnvironment {
  return {
    repoRoot: setup.repo,
    state,
    home: setup.home,
    os: "linux",
    config: CONFIG,
    layers: { location: stateStore(state) },
    options: undefined,
  };
}

describe("runImport", () => {
  test("should warn and keep exit 0 when the sync point write fails", async () => {
    // Arrange
    const setup = fixture();
    const state = join(setup.root, "state");
    writeFileSync(state, "not a folder\n");
    process.env[XDG_STATE_HOME_ENV] = state;
    const syncPoint = join(state, SYNC_POINT_FOLDER, SYNC_POINT_FILE);
    const warning = `  WARNING: could not record the sync point in ${syncPoint}.`;

    // Act
    const result = await runImport(runEnvironment(setup, state), COMMAND);

    // Assert
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(warning);
    expect(result.stdout).not.toContain("Sync point :");
  });

  test("should record the sync point without a warning when the write succeeds", async () => {
    // Arrange
    const setup = fixture();
    const state = join(setup.root, "state");
    mkdirSync(state);
    process.env[XDG_STATE_HOME_ENV] = state;
    const head = git(setup.repo, ["rev-parse", "HEAD"]).trim();

    // Act
    const result = await runImport(runEnvironment(setup, state), COMMAND);

    // Assert
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("WARNING");
    expect(result.stdout).toContain(`  Sync point : ${head.slice(0, 7)}`);
    expect(
      readFileSync(join(state, SYNC_POINT_FOLDER, SYNC_POINT_FILE), "utf8"),
    ).toBe(`${head}\n`);
  });
});
