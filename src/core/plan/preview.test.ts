import { describe, expect, test } from "bun:test";
import type { ConfigV2 } from "../config/types.ts";
import { planPreview } from "./preview.ts";
import type { LocalEntry, RepoFiles, Snapshot } from "./types.ts";

const HOME = "/home/user";

const CONFIG_PATH = "sync-config.json";

const REPO_FILE = "dotfiles/common/test/conf";

const LOCAL_FILE = "/home/user/.config/test/conf";

const MISSING_FROM_WORKING_TREE = "dotfiles/common/test/gone";

const MATCHES_HEAD = "  Nothing would be sent: the repo matches HEAD.";

const NO_CHANGES = "  Repo is up to date. No changes detected.";

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {},
  entries: [
    {
      file: "test/conf",
      module: "test",
      merge: "whole",
      localPath: "~/.config/test/conf",
    },
  ],
};

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function snapshot(
  repoFiles: RepoFiles,
  headFiles: RepoFiles,
  localBytes: Uint8Array,
): Snapshot {
  const local: LocalEntry = {
    kind: "file",
    path: LOCAL_FILE,
    bytes: localBytes,
    mode: 0o644,
  };
  return {
    config: CONFIG,
    os: "linux",
    home: HOME,
    cwd: HOME,
    repoFiles,
    localFiles: new Map([[LOCAL_FILE, local]]),
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
    headFiles,
  };
}

describe("planPreview", () => {
  test("should say the repo differs when HEAD holds a file the working tree lacks", () => {
    // Arrange
    const repoFile = bytes("same\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([
      [REPO_FILE, repoFile],
      [MISSING_FROM_WORKING_TREE, bytes("only committed\n")],
    ]);
    const preview = snapshot(repoFiles, headFiles, repoFile);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NO_CHANGES);
    expect(result.lines).not.toContain(MATCHES_HEAD);
  });

  test("should say the repo differs when the config's bytes differ", () => {
    // Arrange
    const repoFile = bytes("same\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([
      [REPO_FILE, repoFile],
      [CONFIG_PATH, bytes("{}\n")],
    ]);
    const workingTree = new Map([
      [REPO_FILE, repoFile],
      [CONFIG_PATH, bytes('{"changed": true}\n')],
    ]);
    const preview = snapshot(repoFiles, headFiles, repoFile);

    // Act
    const result = planPreview(preview, workingTree);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NO_CHANGES);
    expect(result.lines).not.toContain(MATCHES_HEAD);
  });

  test("should say nothing would be sent when the working tree equals HEAD", () => {
    // Arrange
    const repoFile = bytes("same\n");
    const config = bytes("{}\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([
      [REPO_FILE, repoFile],
      [CONFIG_PATH, config],
    ]);
    const workingTree = new Map([
      [REPO_FILE, repoFile],
      [CONFIG_PATH, config],
    ]);
    const preview = snapshot(repoFiles, headFiles, repoFile);

    // Act
    const result = planPreview(preview, workingTree);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NO_CHANGES);
    expect(result.lines).toContain(MATCHES_HEAD);
  });
});
