import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  previewDiff,
  pushBranch,
  readAheadBehind,
  readHead,
  readHeadTree,
  readMachineAlias,
  readParentSha,
  readPorcelain,
  readSyncPoint,
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

/** A full-length SHA-shaped string that names no commit. */
const ZERO_SHA = "0000000000000000000000000000000000000000";

/** A sync point file that is not a SHA at all. */
const NOT_A_SHA = "abc";

/** The repo's own attribute file, copied so `-text` reaches the throwaway repo. */
const GITATTRIBUTES_URL = new URL("../../.gitattributes", import.meta.url);

/** A dotfile holding both line endings, committed under the `-text` rule. */
const BYTE_EXACT_FILE = "dotfiles/windows/parity.txt";

const BYTE_EXACT_TEXT = "lf line\ncrlf line\r\nlast\n";

/** The documented `core.autocrlf` values the archive must ignore. */
const AUTOCRLF_VALUES = ["input", "true", "false"] as const;

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

/** The preview diff's three dotfiles under `dotfiles/linux/`. */
const PREVIEW_A = "dotfiles/linux/a.txt";
const PREVIEW_B = "dotfiles/linux/b.txt";
const PREVIEW_C = "dotfiles/linux/c.txt";

/** A file sync never exports, so the preview's diff must ignore it. */
const PREVIEW_OTHER = "other.txt";

/** The prefix of the temp folder `previewDiff` makes and must remove again. */
const PREVIEW_TMP_PREFIX = "mksync-preview-";

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

/** The text `bytes` decodes to, for byte-for-byte assertions. */
function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * A repo whose one commit holds `BYTE_EXACT_FILE`, with the repo's own
 * `.gitattributes` and `core.autocrlf` set in this repo only.
 */
function byteExactRepo(autocrlf: string): string {
  const root = emptyRepo();
  copyFileSync(GITATTRIBUTES_URL, join(root, ".gitattributes"));
  mkdirSync(join(root, "dotfiles", "windows"), { recursive: true });
  writeFileSync(join(root, BYTE_EXACT_FILE), BYTE_EXACT_TEXT);
  git(root, ["config", "core.autocrlf", autocrlf]);
  git(root, ["add", "-A"]);
  git(root, [...IDENTITY, "commit", "-q", "-m", "bytes"]);
  return root;
}

/** The bytes `git archive HEAD dotfiles` hands back for `path`. */
function archivedBytes(root: string, path: string): Uint8Array {
  const archive = join(root, "archive.tar");
  git(root, [
    "archive",
    "--format=tar",
    "--output",
    archive,
    "HEAD",
    "dotfiles",
  ]);
  const result = Bun.spawnSync({
    cmd: ["tar", "-xO", "-f", archive, path],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`tar -xO ${path} failed: ${result.stderr.toString()}`);
  }
  return new Uint8Array(result.stdout);
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

describe("readSyncPoint", () => {
  test("should return HEAD's SHA when the file holds it with a newline", async () => {
    // Arrange
    const root = repoWithCommit();
    const state = join(root, "state");
    mkdirSync(state);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(state, "last-sync"), `${sha}\n`);

    // Act
    const point = await readSyncPoint(root, state);

    // Assert
    expect(point).toBe(sha);
  });

  test("should return undefined when the file is missing", async () => {
    // Arrange
    const root = repoWithCommit();
    const state = join(root, "state");
    mkdirSync(state);

    // Act
    const point = await readSyncPoint(root, state);

    // Assert
    expect(point).toBeUndefined();
  });

  test("should return undefined when the file is not a SHA", async () => {
    // Arrange
    const root = repoWithCommit();
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "last-sync"), `${NOT_A_SHA}\n`);

    // Act
    const point = await readSyncPoint(root, state);

    // Assert
    expect(point).toBeUndefined();
  });

  test("should return undefined when the file holds forty zeroes", async () => {
    // Arrange
    const root = repoWithCommit();
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "last-sync"), `${ZERO_SHA}\n`);

    // Act
    const point = await readSyncPoint(root, state);

    // Assert
    expect(point).toBeUndefined();
  });
});

describe("git archive of dotfiles", () => {
  test.each(AUTOCRLF_VALUES)(
    "should keep the committed bytes with core.autocrlf %s",
    (autocrlf) => {
      // Arrange
      const root = byteExactRepo(autocrlf);

      // Act
      const bytes = archivedBytes(root, BYTE_EXACT_FILE);

      // Assert
      expect(textOf(bytes)).toBe(BYTE_EXACT_TEXT);
    },
  );
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
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe(
      `${REPO_FILE}\n`,
    );
  });
});

/** A seeded repo whose own config holds a test identity: `commitStaged` runs a
 * real `git commit`, and a CI runner has no identity of its own. Only this
 * temp repo's config is written. */
function repoWithIdentity(): string {
  const root = repoWithCommit();
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  return root;
}

describe("commitStaged", () => {
  test("should commit the staged changes with the message", async () => {
    // Arrange
    const root = repoWithIdentity();
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
    const root = repoWithIdentity();

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

/** A repo whose one commit holds the config, two dotfiles and a file sync never
 * exports, for the preview-diff cases. */
function previewRepo(): string {
  const root = emptyRepo();
  writeFileSync(join(root, CONFIG_PATH), "{}\n");
  mkdirSync(join(root, "dotfiles", "linux"), { recursive: true });
  writeFileSync(join(root, PREVIEW_A), "a\n");
  writeFileSync(join(root, PREVIEW_B), "b\n");
  writeFileSync(join(root, PREVIEW_OTHER), "other\n");
  git(root, ["add", "-A"]);
  git(root, [...IDENTITY, "commit", "-q", "-m", "preview"]);
  return root;
}

/** How many `mksync-preview-*` temp folders are left in the system tmpdir. */
function countPreviewFolders(): number {
  return readdirSync(tmpdir()).filter((name) =>
    name.startsWith(PREVIEW_TMP_PREFIX),
  ).length;
}

/** The bytes `text` encodes to, for building a preview's exported tree. */
function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("previewDiff", () => {
  test("should stat and diff a change, an add and a removal", async () => {
    // Arrange
    const root = previewRepo();
    const files = new Map<string, Uint8Array>([
      [CONFIG_PATH, encodeText("{}\n")],
      [PREVIEW_A, encodeText("a modified\n")],
      [PREVIEW_C, encodeText("c\n")],
    ]);

    // Act
    const result = await previewDiff(root, files);

    // Assert
    expect(result).toBeDefined();
    expect(result?.stat).toContain(PREVIEW_A);
    expect(result?.stat).toContain(PREVIEW_B);
    expect(result?.stat).toContain(PREVIEW_C);
    expect(result?.stat).toContain("3 files changed");
    expect(result?.diff).toContain(`diff --git a/${PREVIEW_A} b/${PREVIEW_A}`);
    expect(result?.diff).toContain("new file mode 100644");
    expect(result?.diff).toContain("deleted file mode 100644");
    expect(result?.diff).toContain("+a modified");
  });

  test("should leave HEAD, the index, the file and tmpdir untouched", async () => {
    // Arrange
    const root = previewRepo();
    const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
    const indexBefore = readFileSync(join(root, ".git", "index"));
    const aBefore = readFileSync(join(root, PREVIEW_A));
    const foldersBefore = countPreviewFolders();
    const files = new Map<string, Uint8Array>([
      [CONFIG_PATH, encodeText("{}\n")],
      [PREVIEW_A, encodeText("a modified\n")],
    ]);

    // Act
    await previewDiff(root, files);

    // Assert
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(root, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
    expect(readFileSync(join(root, PREVIEW_A))).toEqual(aBefore);
    expect(countPreviewFolders()).toBe(foldersBefore);
  });

  test("should report no change for a tree equal to HEAD", async () => {
    // Arrange
    const root = previewRepo();
    const files = new Map<string, Uint8Array>([
      [CONFIG_PATH, encodeText("{}\n")],
      [PREVIEW_A, encodeText("a\n")],
      [PREVIEW_B, encodeText("b\n")],
    ]);

    // Act
    const result = await previewDiff(root, files);

    // Assert
    expect(result).toEqual({ stat: "", diff: "" });
  });

  test("should keep an executable file's mode when its bytes change", async () => {
    // Arrange
    const root = emptyRepo();
    mkdirSync(join(root, "dotfiles", "linux"), { recursive: true });
    writeFileSync(join(root, PREVIEW_A), "#!/bin/sh\necho hi\n");
    chmodSync(join(root, PREVIEW_A), 0o755);
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "exec"]);
    const files = new Map<string, Uint8Array>([
      [PREVIEW_A, encodeText("#!/bin/sh\necho hi changed\n")],
    ]);

    // Act
    const result = await previewDiff(root, files);

    // Assert
    expect(result).toBeDefined();
    expect(result?.diff).toContain(`diff --git a/${PREVIEW_A} b/${PREVIEW_A}`);
    expect(result?.diff).not.toContain("old mode");
    expect(result?.diff).not.toContain("new mode");
  });

  test("should report no preview in a repo with no commit", async () => {
    // Arrange
    const root = emptyRepo();
    const files = new Map<string, Uint8Array>([[PREVIEW_A, encodeText("a\n")]]);

    // Act
    const result = await previewDiff(root, files);

    // Assert
    expect(result).toBeUndefined();
  });
});
