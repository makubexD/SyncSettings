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
  commitExists,
  readHead,
  readHeadTree,
  readPorcelain,
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

/** A repo with one commit holding `sync-config.json` and one dotfile. */
function repoWithCommit(): string {
  const root = emptyRepo();
  writeFileSync(join(root, CONFIG_PATH), "{}\n");
  mkdirSync(join(root, "dotfiles", "common", "git"), { recursive: true });
  writeFileSync(join(root, REPO_FILE), "name = repo\n");
  git(root, ["add", "-A"]);
  git(root, [...IDENTITY, "commit", "-q", "-m", "initial"]);
  return root;
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
