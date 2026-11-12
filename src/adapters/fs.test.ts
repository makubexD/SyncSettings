import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigV2, ConfigV2Entry, Os } from "../core/config/types.ts";
import type { Action, Snapshot } from "../core/plan/types.ts";
import { readSnapshot, runActions } from "./fs.ts";
import { expandHome, homeFolder, stateFolder } from "./paths.ts";

const FILE_MODE = 0o644;

const PRIVATE_MODE = 0o600;

const BACKUP_MODE = 0o640;

const FOLDER_MODE = 0o755;

const ERROR_PREFIX = "  ERROR      ";

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

function repoContext(repo: string): { readonly repoRoot: string; readonly os: Os } {
  return { repoRoot: repo, os: "linux" };
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
    expect(textOf(snapshot.repoFiles.get("dotfiles/common/git/config") ?? new Uint8Array())).toBe(
      "name = repo\n",
    );
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
    expect(snapshot.localFiles.get(join(localDir, "settings.json"))?.kind).toBe("file");
    expect(snapshot.localFiles.get(join(localDir, "snippets", "git.json"))?.kind).toBe("file");
    expect(snapshot.localFiles.get(link)?.kind).toBe("symlink");
    expect(snapshot.localDirs.has(localDir)).toBe(true);
    expect(snapshot.localDirs.has(join(localDir, "snippets"))).toBe(true);
  });

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
    writeFixture(join(repo, "dotfiles", "linux", "shell", "bashrc"), "export A=1\n");
    writeFixture(join(repo, "dotfiles", "windows", "shell", "profile.ps1"), "#\n");
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

describe("runActions", () => {
  test("should write a repo file, creating its folder first", () => {
    // Arrange
    const { repo } = fixture();
    const actions: Action[] = [
      { kind: "mkdir", path: "dotfiles/linux/shell" },
      {
        kind: "writeRepo",
        path: "dotfiles/linux/shell/bashrc",
        bytes: bytesOf("export A=1\n"),
      },
    ];

    // Act
    const lines = runActions(actions, repoContext(repo));

    // Assert
    expect(lines).toEqual([]);
    expect(
      readFileSync(join(repo, "dotfiles", "linux", "shell", "bashrc"), "utf8"),
    ).toBe("export A=1\n");
  });

  test("should remove a repo file", () => {
    // Arrange
    const { repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "x\n");

    // Act
    const lines = runActions(
      [{ kind: "removeRepo", path: "dotfiles/common/git/config" }],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
    expect(existsSync(repoFile)).toBe(false);
  });

  test("should write a local file named by an absolute path", () => {
    // Arrange
    const { home, repo } = fixture();
    const localFile = join(home, ".gitconfig");

    // Act
    const lines = runActions(
      [{ kind: "writeLocal", path: localFile, bytes: bytesOf("name = user\n") }],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
    expect(readFileSync(localFile, "utf8")).toBe("name = user\n");
  });

  test("should keep an existing target's mode when writing", () => {
    // Arrange
    const { repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "old\n", PRIVATE_MODE);

    // Act
    const lines = runActions(
      [
        {
          kind: "writeRepo",
          path: "dotfiles/common/git/config",
          bytes: bytesOf("new\n"),
        },
      ],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
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

    // Act
    const lines = runActions(
      [{ kind: "backup", path: localFile }],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
    expect(readFileSync(backup, "utf8")).toBe("old\n");
    expect(statSync(backup).mode & 0o7777).toBe(BACKUP_MODE);
    expect(statSync(backup).mtime.getTime()).toBe(source.mtime.getTime());
  });

  test("should create a folder and its parents", () => {
    // Arrange
    const { home, repo } = fixture();
    const folder = join(home, ".local", "state", "sync-settings");

    // Act
    const lines = runActions(
      [{ kind: "mkdir", path: folder }],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
    expect(statSync(folder).isDirectory()).toBe(true);
  });

  test("should set a mode on a repo file", () => {
    // Arrange
    const { repo } = fixture();
    const repoFile = join(repo, "dotfiles", "common", "git", "config");
    writeFixture(repoFile, "x\n", FILE_MODE);

    // Act
    const lines = runActions(
      [{ kind: "chmod", path: "dotfiles/common/git/config", mode: PRIVATE_MODE }],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
    expect(statSync(repoFile).mode & 0o7777).toBe(PRIVATE_MODE);
  });

  test("should write the state file and create its folder", () => {
    // Arrange
    const { home, repo } = fixture();
    const stateFile = join(home, ".local", "state", "sync-settings", "last-sync");

    // Act
    const lines = runActions(
      [{ kind: "writeState", path: stateFile, text: "0123456789abcdef\n" }],
      repoContext(repo),
    );

    // Assert
    expect(lines).toEqual([]);
    expect(readFileSync(stateFile, "utf8")).toBe("0123456789abcdef\n");
  });

  test("should turn a failing write into an ERROR line and run the next action", () => {
    // Arrange
    const { home, repo } = fixture();
    const blocked = join(home, "blocked");
    mkdirSync(blocked);
    const later = join(home, "later.txt");

    // Act
    const lines = runActions(
      [
        { kind: "writeLocal", path: blocked, bytes: bytesOf("x\n") },
        { kind: "writeLocal", path: later, bytes: bytesOf("later\n") },
      ],
      repoContext(repo),
    );

    // Assert
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.startsWith(ERROR_PREFIX)).toBe(true);
    expect(line).toContain(blocked);
    expect(readFileSync(later, "utf8")).toBe("later\n");
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
    const xdg = stateFolder("linux", "/home/user", { XDG_STATE_HOME: "/state" });
    const windows = stateFolder("windows", "C:\\Users\\user", {
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
    });

    // Assert
    expect(linux).toBe("/home/user/.local/state/sync-settings");
    expect(xdg).toBe("/state/sync-settings");
    expect(windows).toBe("C:\\Users\\user\\AppData\\Local\\SyncSettings");
  });
});
