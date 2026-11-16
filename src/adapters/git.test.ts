import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSyncPaths,
  commitExists,
  commitStaged,
  deleteBranch,
  pushBranch,
  readAheadBehind,
  readHead,
  readHeadTree,
  readMachineAlias,
  readParentSha,
  readPorcelain,
  readUnpushedHistory,
  runGitResult,
  stagePaths,
  statusPorcelain,
  switchToMaster,
  switchToNewBranch,
} from "./git.ts";

/** A per-command identity: never written to any git config, local or global. */
const IDENTITY = [
  "-c",
  "user.name=Test User",
  "-c",
  "user.email=test@example.com",
] as const;

const CONFIG_PATH = "sync-config.json";

const REPO_FILE = "dotfiles/common/git/config";

const MISSING_REPO_PATH = "dotfiles/common/git/missing";

const UNKNOWN_SHA = "0123456789abcdef0123456789abcdef01234567";

const UNTRACKED_FILE = "dotfiles/common/git/new";

const OUTSIDE_FILE = "README.md";

const NEW_BRANCH = "sync/linux-laptop-20260101-0000";

const MACHINE_ALIAS_KEY = "syncsettings.machine";

const MACHINE_ALIAS = "laptop";

const COMMIT_MESSAGE = "sync: test";

const MASTER = "master";

/** A path git quotes without `-z`, because of its non-ASCII bytes. */
const ACCENTED_PROFILE_FILE = "profiles/josé.json";

/** A path with a space, which git never quotes but must still read whole. */
const SPACED_PROFILE_FILE = "profiles/with space.json";

/** A path whose only unpushed change is a deletion. */
const DELETED_PROFILE_FILE = "profiles/deleted.json";

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-git-"));
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

/** Run a setup git command that must succeed; returns its stdout. */
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

function emptyRepo(): string {
  const root = tempFolder();
  git(root, ["init", "-q"]);
  return root;
}

/** Seed `root` with one commit holding the config and one dotfile. */
function seedCommit(root: string): string {
  writeFileSync(join(root, CONFIG_PATH), "{}\n");
  mkdirSync(join(root, "dotfiles", "common", "git"), { recursive: true });
  writeFileSync(join(root, REPO_FILE), "name = repo\n");
  git(root, ["add", "-A"]);
  git(root, [...IDENTITY, "commit", "-q", "-m", "initial"]);
  return root;
}

/** A repo with one commit holding `sync-config.json` and one dotfile. */
function repoWithCommit(): string {
  return seedCommit(emptyRepo());
}

/** A repo whose first branch is `master`, for the origin cases. */
function masterRepo(): string {
  const root = tempFolder();
  git(root, ["init", "-q"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  return root;
}

/** A bare `master` origin and a seeded clone that tracks it. */
function repoWithOrigin(): { readonly root: string; readonly origin: string } {
  const origin = tempFolder();
  git(origin, ["init", "-q", "--bare"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  const root = seedCommit(masterRepo());
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "-u", "origin", MASTER]);
  return { root, origin };
}

/** A second clone of `origin`, whose first branch is `master`. */
function cloneOf(origin: string): string {
  const parent = tempFolder();
  git(parent, ["clone", "-q", origin, "clone"]);
  return join(parent, "clone");
}

/** The branch `root` has checked out. */
function currentBranch(root: string): string {
  return git(root, ["symbolic-ref", "--short", "HEAD"]).trim();
}

describe("readHead", () => {
  test("should return HEAD's SHA when the repo has a commit", async () => {
    // Arrange
    const root = repoWithCommit();
    const expected = git(root, ["rev-parse", "HEAD"]).trim();

    // Act
    const sha = await readHead(root);

    // Assert
    expect(sha).toBe(expected);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("should report no HEAD in an empty repo", async () => {
    // Arrange
    const root = emptyRepo();

    // Act
    const sha = await readHead(root);

    // Assert
    expect(sha).toBeUndefined();
  });

  test("should report no HEAD in a folder that is not a git repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const sha = await readHead(root);

    // Assert
    expect(sha).toBeUndefined();
  });
});

describe("readPorcelain", () => {
  test("should return an empty string for a clean tree", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const porcelain = await readPorcelain(root);

    // Assert
    expect(porcelain).toBe("");
  });

  test("should return the raw status for a modified dotfile", async () => {
    // Arrange
    const root = repoWithCommit();
    writeFileSync(join(root, REPO_FILE), "name = changed\n");

    // Act
    const porcelain = await readPorcelain(root);

    // Assert
    expect(porcelain).toBe(` M ${REPO_FILE}\n`);
  });

  test("should return the raw status for an untracked dotfile", async () => {
    // Arrange
    const root = repoWithCommit();
    const untracked = "dotfiles/common/git/new";
    writeFileSync(join(root, untracked), "new\n");

    // Act
    const porcelain = await readPorcelain(root);

    // Assert
    expect(porcelain).toBe(`?? ${untracked}\n`);
  });

  test("should track the v2 config's changes", async () => {
    // Arrange
    const root = repoWithCommit();
    const v2Config = "sync-config.v2.json";
    writeFileSync(join(root, v2Config), "{}\n");

    // Act
    const porcelain = await readPorcelain(root);

    // Assert
    expect(porcelain).toBe(`?? ${v2Config}\n`);
  });

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const porcelain = await readPorcelain(root);

    // Assert
    expect(porcelain).toBeUndefined();
  });
});

describe("readHeadTree", () => {
  test("should return HEAD's bytes after a file leaves the working tree", async () => {
    // Arrange
    const root = repoWithCommit();
    const binaryPath = "dotfiles/common/git/raw.bin";
    const binary = Uint8Array.from([0x68, 0x69, 0x00, 0xff, 0x0a]);
    writeFileSync(join(root, binaryPath), binary);
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "binary"]);
    rmSync(join(root, REPO_FILE));
    rmSync(join(root, binaryPath));

    // Act
    const files = await readHeadTree(root);

    // Assert
    expect(files).toBeDefined();
    expect(new TextDecoder().decode(files?.get(CONFIG_PATH))).toBe("{}\n");
    expect(new TextDecoder().decode(files?.get(REPO_FILE))).toBe(
      "name = repo\n",
    );
    expect(Array.from(files?.get(binaryPath) ?? [])).toEqual(
      Array.from(binary),
    );
  });

  test("should report no HEAD in an empty repo", async () => {
    // Arrange
    const root = emptyRepo();

    // Act
    const files = await readHeadTree(root);

    // Assert
    expect(files).toBeUndefined();
  });

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const files = await readHeadTree(root);

    // Assert
    expect(files).toBeUndefined();
  });
});

describe("commitExists", () => {
  test("should accept a SHA that names an existing commit", async () => {
    // Arrange
    const root = repoWithCommit();
    const sha = git(root, ["rev-parse", "HEAD"]).trim();

    // Act
    const exists = await commitExists(root, sha);

    // Assert
    expect(exists).toBe(true);
  });

  test("should reject a SHA that names no commit", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const exists = await commitExists(root, UNKNOWN_SHA);

    // Assert
    expect(exists).toBe(false);
  });

  test("should reject any SHA outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const exists = await commitExists(root, UNKNOWN_SHA);

    // Assert
    expect(exists).toBe(false);
  });
});

describe("runGitResult", () => {
  test("should return a failing git run as a result", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const result = await runGitResult(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "no-such-ref",
    ]);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
  });

  test("should capture stderr from a failure", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await runGitResult(root, ["status"]);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.code).toBe(128);
    expect(result.stderr).toContain("not a git repository");
  });

  test("should report a git that cannot start as code -1", async () => {
    // Arrange
    const root = repoWithCommit();
    const missingRoot = join(root, "missing");

    // Act
    const result = await runGitResult(missingRoot, ["status"]);

    // Assert
    expect(result).toEqual({
      code: -1,
      stdout: "",
      stderr: "",
      ok: false,
    });
  });
});

describe("statusPorcelain", () => {
  test("should report every change when no pathspec is given", async () => {
    // Arrange
    const root = repoWithCommit();
    writeFileSync(join(root, OUTSIDE_FILE), "outside\n");
    writeFileSync(join(root, REPO_FILE), "name = changed\n");

    // Act
    const result = await statusPorcelain(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(`?? ${OUTSIDE_FILE}`);
    expect(result.stdout).toContain(` M ${REPO_FILE}`);
  });

  test("should limit the read to the given pathspecs", async () => {
    // Arrange
    const root = repoWithCommit();
    writeFileSync(join(root, OUTSIDE_FILE), "outside\n");
    writeFileSync(join(root, REPO_FILE), "name = changed\n");

    // Act
    const result = await statusPorcelain(root, ["dotfiles"]);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(` M ${REPO_FILE}`);
    expect(result.stdout).not.toContain(OUTSIDE_FILE);
  });

  test("should report a clean tree as empty output", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const result = await statusPorcelain(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
  });

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await statusPorcelain(root);

    // Assert
    expect(result.ok).toBe(false);
  });
});

describe("changedSyncPaths", () => {
  test("should list modified and untracked sync files", async () => {
    // Arrange
    const root = repoWithCommit();
    writeFileSync(join(root, REPO_FILE), "name = changed\n");
    writeFileSync(join(root, UNTRACKED_FILE), "new\n");

    // Act
    const result = await changedSyncPaths(root, ["dotfiles"]);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([REPO_FILE, UNTRACKED_FILE]);
  });

  test("should list a deleted sync file too", async () => {
    // Arrange
    const root = repoWithCommit();
    rmSync(join(root, REPO_FILE));

    // Act
    const result = await changedSyncPaths(root, ["dotfiles"]);

    // Assert
    expect(result.paths).toEqual([REPO_FILE]);
  });

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await changedSyncPaths(root, ["dotfiles"]);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.paths).toEqual([]);
  });
});

describe("readUnpushedHistory", () => {
  test("should list one path list per unpushed commit", async () => {
    // Arrange
    const { root } = repoWithOrigin();
    mkdirSync(join(root, "profiles"), { recursive: true });
    writeFileSync(join(root, "profiles", "work.json"), "{}\n");
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "profile"]);
    mkdirSync(join(root, "machines"), { recursive: true });
    writeFileSync(join(root, "machines", "box.json"), "{}\n");
    writeFileSync(join(root, "profiles", "work.json"), '{"a":1}\n');
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "machine"]);

    // Act
    const result = await readUnpushedHistory(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual([
      ["machines/box.json", "profiles/work.json"],
      ["profiles/work.json"],
    ]);
  });

  test("should list a non-ASCII path unquoted", async () => {
    // Arrange
    const { root } = repoWithOrigin();
    mkdirSync(join(root, "profiles"), { recursive: true });
    writeFileSync(join(root, ACCENTED_PROFILE_FILE), "{}\n");
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "accented profile"]);

    // Act
    const result = await readUnpushedHistory(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual([[ACCENTED_PROFILE_FILE]]);
  });

  test("should list a path with a space whole", async () => {
    // Arrange
    const { root } = repoWithOrigin();
    mkdirSync(join(root, "profiles"), { recursive: true });
    writeFileSync(join(root, SPACED_PROFILE_FILE), "{}\n");
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "spaced profile"]);

    // Act
    const result = await readUnpushedHistory(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual([[SPACED_PROFILE_FILE]]);
  });

  test("should give no path for a commit that only deletes a file", async () => {
    // Arrange
    const { root } = repoWithOrigin();
    mkdirSync(join(root, "profiles"), { recursive: true });
    writeFileSync(join(root, DELETED_PROFILE_FILE), "{}\n");
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "add profile"]);
    git(root, ["rm", "-q", DELETED_PROFILE_FILE]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "delete profile"]);

    // Act
    const result = await readUnpushedHistory(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual([[DELETED_PROFILE_FILE]]);
  });

  test("should report no commits when nothing is unpushed", async () => {
    // Arrange
    const { root } = repoWithOrigin();

    // Act
    const result = await readUnpushedHistory(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.commits).toEqual([]);
  });

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await readUnpushedHistory(root);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.commits).toEqual([]);
  });
});

describe("readAheadBehind", () => {
  test("should count a local commit as ahead", async () => {
    // Arrange
    const { root } = repoWithOrigin();
    writeFileSync(join(root, REPO_FILE), "name = local\n");
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "local"]);

    // Act
    const result = await readAheadBehind(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(0);
  });

  test("should count an upstream commit as behind", async () => {
    // Arrange
    const { root, origin } = repoWithOrigin();
    const clone = cloneOf(origin);
    writeFileSync(join(clone, "upstream.txt"), "upstream\n");
    git(clone, ["add", "-A"]);
    git(clone, [...IDENTITY, "commit", "-q", "-m", "upstream"]);
    git(clone, ["push", "-q", "origin", MASTER]);
    git(root, ["fetch", "-q", "origin"]);

    // Act
    const result = await readAheadBehind(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(1);
  });

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await readAheadBehind(root);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });
});

describe("readMachineAlias", () => {
  test("should read the alias from git config", async () => {
    // Arrange
    const root = repoWithCommit();
    git(root, ["config", MACHINE_ALIAS_KEY, MACHINE_ALIAS]);

    // Act
    const result = await readMachineAlias(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.alias).toBe(MACHINE_ALIAS);
  });

  test("should report no alias when the key is unset", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const result = await readMachineAlias(root);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.alias).toBeUndefined();
  });

  test("should report no alias outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const result = await readMachineAlias(root);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.alias).toBeUndefined();
  });
});

describe("switchToNewBranch", () => {
  test("should create and switch to the branch", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const result = await switchToNewBranch(root, NEW_BRANCH);

    // Assert
    expect(result.ok).toBe(true);
    expect(currentBranch(root)).toBe(NEW_BRANCH);
  });

  test("should refuse a branch that already exists", async () => {
    // Arrange
    const root = repoWithCommit();
    await switchToNewBranch(root, NEW_BRANCH);

    // Act
    const result = await switchToNewBranch(root, NEW_BRANCH);

    // Assert
    expect(result.ok).toBe(false);
    expect(currentBranch(root)).toBe(NEW_BRANCH);
  });
});

describe("stagePaths", () => {
  test("should stage only the given paths", async () => {
    // Arrange
    const root = repoWithCommit();
    writeFileSync(join(root, REPO_FILE), "name = changed\n");
    writeFileSync(join(root, OUTSIDE_FILE), "outside\n");

    // Act
    const result = await stagePaths(root, [REPO_FILE]);

    // Assert
    expect(result.ok).toBe(true);
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe(`${REPO_FILE}\n`);
  });
});

describe("commitStaged", () => {
  test("should commit the staged changes with the message", async () => {
    // Arrange
    const root = repoWithCommit();
    writeFileSync(join(root, REPO_FILE), "name = changed\n");
    await stagePaths(root, [REPO_FILE]);

    // Act
    const result = await commitStaged(root, COMMIT_MESSAGE);

    // Assert
    expect(result.ok).toBe(true);
    expect(git(root, ["log", "-1", "--format=%s"]).trim()).toBe(COMMIT_MESSAGE);
  });

  test("should report nothing to commit as a failure", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const result = await commitStaged(root, COMMIT_MESSAGE);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.stdout).toContain("nothing to commit");
  });
});

describe("pushBranch", () => {
  test("should push the branch and set its upstream", async () => {
    // Arrange
    const { root, origin } = repoWithOrigin();
    await switchToNewBranch(root, NEW_BRANCH);
    writeFileSync(join(root, REPO_FILE), "name = changed\n");
    await stagePaths(root, [REPO_FILE]);
    await commitStaged(root, COMMIT_MESSAGE);
    const head = git(root, ["rev-parse", "HEAD"]).trim();

    // Act
    const result = await pushBranch(root, NEW_BRANCH);

    // Assert
    expect(result.ok).toBe(true);
    expect(git(origin, ["rev-parse", `refs/heads/${NEW_BRANCH}`]).trim()).toBe(
      head,
    );
  });
});

describe("switchToMaster", () => {
  test("should switch back to master", async () => {
    // Arrange
    const root = seedCommit(masterRepo());
    await switchToNewBranch(root, NEW_BRANCH);

    // Act
    const result = await switchToMaster(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(currentBranch(root)).toBe(MASTER);
  });
});

describe("deleteBranch", () => {
  test("should delete an unmerged branch", async () => {
    // Arrange
    const root = seedCommit(masterRepo());
    await switchToNewBranch(root, NEW_BRANCH);
    await switchToMaster(root);

    // Act
    const result = await deleteBranch(root, NEW_BRANCH);

    // Assert
    expect(result.ok).toBe(true);
    expect(git(root, ["branch", "--list", NEW_BRANCH])).toBe("");
  });
});

describe("readParentSha", () => {
  test("should return the parent commit's SHA", async () => {
    // Arrange
    const root = repoWithCommit();
    const first = git(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(root, REPO_FILE), "name = second\n");
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "second"]);

    // Act
    const result = await readParentSha(root);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.sha).toBe(first);
  });

  test("should report no parent on a root commit", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const result = await readParentSha(root);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.sha).toBeUndefined();
  });
});
