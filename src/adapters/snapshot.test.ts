import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoFiles } from "../core/plan/types.ts";
import {
  findRepoRoot,
  loadConfig,
  previewWorkingTree,
  V1_CONFIG,
  V2_CONFIG,
} from "./snapshot.ts";

const V1_TEXT = '{"files":[]}\n';

const V2_TEXT =
  '{"schemaVersion":2,"modules":{"base":{"description":"Base"}},"entries":[]}\n';

const REPO_FILE = "dotfiles/common/parity/a.conf";

const CONFIG_BYTES = Uint8Array.from([0x7b, 0x7d, 0x0a]);

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-snapshot-"));
  tempFolders.push(folder);
  return folder;
}

function writeFixture(path: string, text: string): void {
  writeFileSync(path, text);
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

function expectBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(Array.from(actual ?? new Uint8Array())).toEqual(Array.from(expected));
}

describe("findRepoRoot", () => {
  test("should find the folder holding sync-config.json from a nested subfolder", () => {
    // Arrange
    const root = tempFolder();
    writeFixture(join(root, V1_CONFIG), V1_TEXT);
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    // Act
    const found = findRepoRoot(nested);

    // Assert
    expect(found).toBe(root);
  });

  test("should return undefined when no config sits in the folder or its parents", () => {
    // Arrange
    const root = tempFolder();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    // Act
    const found = findRepoRoot(nested);

    // Assert
    expect(found).toBeUndefined();
  });
});

describe("loadConfig", () => {
  test("should prefer sync-config.v2.json when both configs exist", () => {
    // Arrange
    const root = tempFolder();
    writeFixture(join(root, V1_CONFIG), V1_TEXT);
    writeFixture(join(root, V2_CONFIG), V2_TEXT);

    // Act
    const loaded = loadConfig(root);

    // Assert
    expect(loaded).toEqual({ ok: true, value: JSON.parse(V2_TEXT) });
  });

  test("should report cannot read sync-config.json when neither config exists", () => {
    // Arrange
    const root = tempFolder();

    // Act
    const loaded = loadConfig(root);

    // Assert
    expect(loaded).toEqual({
      ok: false,
      error: { message: "ERROR: cannot read sync-config.json.", code: 1 },
    });
  });
});

describe("previewWorkingTree", () => {
  test("should add sync-config.json's bytes when it is in the working tree", () => {
    // Arrange
    const root = tempFolder();
    const configPath = join(root, V1_CONFIG);
    writeFileSync(configPath, CONFIG_BYTES);
    const repoFiles: RepoFiles = new Map([[REPO_FILE, Uint8Array.from([0x41])]]);

    // Act
    const tree = previewWorkingTree(root, repoFiles);

    // Assert
    expectBytes(tree.get(V1_CONFIG), new Uint8Array(readFileSync(configPath)));
    expectBytes(tree.get(REPO_FILE), Uint8Array.from([0x41]));
  });

  test("should leave the map unchanged when sync-config.json is absent", () => {
    // Arrange
    const root = tempFolder();
    const repoFiles: RepoFiles = new Map([[REPO_FILE, Uint8Array.from([0x41])]]);

    // Act
    const tree = previewWorkingTree(root, repoFiles);

    // Assert
    expect(Array.from(tree.keys())).toEqual(Array.from(repoFiles.keys()));
  });
});
