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
  readFileAtHead,
  readHead,
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

  test("should report that git cannot tell outside a repo", async () => {
    // Arrange
    const root = tempFolder();

    // Act
    const porcelain = await readPorcelain(root);

    // Assert
    expect(porcelain).toBeUndefined();
  });
});

describe("readFileAtHead", () => {
  test("should return a committed file's bytes", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const bytes = await readFileAtHead(root, REPO_FILE);

    // Assert
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe("name = repo\n");
  });

  test("should keep a non-UTF-8 file byte for byte", async () => {
    // Arrange
    const root = repoWithCommit();
    const raw = Uint8Array.from([0x68, 0x69, 0xff, 0x00, 0x74, 0x0a]);
    const path = "dotfiles/common/git/raw.bin";
    writeFileSync(join(root, path), raw);
    git(root, ["add", "-A"]);
    git(root, [...IDENTITY, "commit", "-q", "-m", "raw"]);

    // Act
    const bytes = await readFileAtHead(root, path);

    // Assert
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes ?? new Uint8Array())).toEqual(Array.from(raw));
  });

  test("should return undefined for a path that is not in HEAD", async () => {
    // Arrange
    const root = repoWithCommit();

    // Act
    const bytes = await readFileAtHead(root, MISSING_REPO_PATH);

    // Assert
    expect(bytes).toBeUndefined();
  });

  test("should return undefined when the repo has no commit", async () => {
    // Arrange
    const root = emptyRepo();

    // Act
    const bytes = await readFileAtHead(root, REPO_FILE);

    // Assert
    expect(bytes).toBeUndefined();
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
