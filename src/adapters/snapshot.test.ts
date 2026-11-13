import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigV2 } from "../core/config/types.ts";
import type { RepoFiles, Snapshot } from "../core/plan/types.ts";
import { readSnapshot } from "./fs.ts";
import {
  findRepoRoot,
  loadConfig,
  loadLayers,
  previewWorkingTree,
  V1_CONFIG,
  V2_CONFIG,
} from "./snapshot.ts";
import type { Layers } from "./snapshot.ts";

const V1_TEXT = '{"files":[]}\n';

const V2_TEXT =
  '{"schemaVersion":2,"modules":{"base":{"description":"Base"}},"entries":[]}\n';

const REPO_FILE = "dotfiles/common/parity/a.conf";

const CONFIG_BYTES = Uint8Array.from([0x7b, 0x7d, 0x0a]);

const PROFILE_NAME = "work-1";

const MACHINE_NAME = "home-pc";

const PROFILE_TEXT = '{"modules":["base"]}\n';

const PROFILE_LAYER_FILE = `profiles/${PROFILE_NAME}/parity/settings.json`;

const MACHINE_LAYER_FILE = `machines/${MACHINE_NAME}/parity/settings.json`;

const LAYER_BYTES = '{"a":3}\n';

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-snapshot-"));
  tempFolders.push(folder);
  return folder;
}

function writeFixture(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
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

function textOfBytes(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
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

function baseConfig(): ConfigV2 {
  return {
    schemaVersion: 2,
    modules: { base: { description: "Base" } },
    entries: [],
  };
}

interface StateFixture {
  readonly home: string;
  readonly repo: string;
  readonly state: string;
}

/** A throwaway home, repo and state folder, never the real one. */
function stateFixture(): StateFixture {
  const root = tempFolder();
  const home = join(root, "home", "user");
  const repo = join(root, "repo");
  const state = join(root, "state");
  for (const folder of [home, repo, state]) {
    mkdirSync(folder, { recursive: true });
  }
  return { home, repo, state };
}

function snapshotOf(fixture: StateFixture, layers: Layers): Snapshot {
  return readSnapshot({
    repoRoot: fixture.repo,
    config: baseConfig(),
    os: "linux",
    home: fixture.home,
    cwd: fixture.home,
    values: {},
    env: {},
    only: [],
    stateFolder: fixture.state,
    ...(layers.profile !== undefined ? { profile: layers.profile } : {}),
    ...(layers.machine !== undefined ? { machine: layers.machine } : {}),
  });
}

describe("loadLayers", () => {
  test("should give no layers when SYNC_PROFILE and SYNC_MACHINE are unset", () => {
    // Arrange
    const fixture = stateFixture();

    // Act
    const layers = loadLayers({}, baseConfig(), fixture.state);

    // Assert
    expect(layers).toEqual({ ok: true, value: {} });
  });

  test("should parse the profile file SYNC_PROFILE names", () => {
    // Arrange
    const fixture = stateFixture();
    writeFixture(join(fixture.state, "profiles", `${PROFILE_NAME}.json`), PROFILE_TEXT);

    // Act
    const layers = loadLayers({ SYNC_PROFILE: PROFILE_NAME }, baseConfig(), fixture.state);

    // Assert
    expect(layers).toEqual({
      ok: true,
      value: {
        profile: {
          name: PROFILE_NAME,
          modules: ["base"],
          values: {},
          destinations: {},
          retired: false,
        },
      },
    });
  });

  test("should report an unknown profile with exit code 2", () => {
    // Arrange
    const fixture = stateFixture();
    const path = join(fixture.state, "profiles", `${PROFILE_NAME}.json`);

    // Act
    const layers = loadLayers({ SYNC_PROFILE: PROFILE_NAME }, baseConfig(), fixture.state);

    // Assert
    expect(layers).toEqual({
      ok: false,
      error: {
        message: `ERROR: profile ${PROFILE_NAME} not found: ${path}`,
        code: 2,
      },
    });
  });

  test("should report a name outside lowercase letters, digits and - with exit code 2", () => {
    // Arrange
    const fixture = stateFixture();

    // Act
    const layers = loadLayers({ SYNC_PROFILE: "Work_1" }, baseConfig(), fixture.state);

    // Assert
    expect(layers).toEqual({
      ok: false,
      error: {
        message:
          "ERROR: SYNC_PROFILE must be lowercase letters, digits and -; this is Work_1.",
        code: 2,
      },
    });
  });

  test("should give the machine SYNC_MACHINE names", () => {
    // Arrange
    const fixture = stateFixture();

    // Act
    const layers = loadLayers({ SYNC_MACHINE: MACHINE_NAME }, baseConfig(), fixture.state);

    // Assert
    expect(layers).toEqual({ ok: true, value: { machine: MACHINE_NAME } });
  });
});

describe("readSnapshot with layers", () => {
  test("should leave layer files out when no profile or machine is set", () => {
    // Arrange
    const fixture = stateFixture();
    writeFixture(join(fixture.state, PROFILE_LAYER_FILE), LAYER_BYTES);
    const layers = loadLayers({}, baseConfig(), fixture.state);
    if (!layers.ok) {
      throw new Error("the fixture has no layers");
    }

    // Act
    const snapshot = snapshotOf(fixture, layers.value);

    // Assert
    expect([...snapshot.repoFiles.keys()]).toEqual([]);
  });

  test("should add a profile's layer file under profiles/<name>/", () => {
    // Arrange
    const fixture = stateFixture();
    writeFixture(join(fixture.state, "profiles", `${PROFILE_NAME}.json`), PROFILE_TEXT);
    writeFixture(join(fixture.state, PROFILE_LAYER_FILE), LAYER_BYTES);
    const layers = loadLayers({ SYNC_PROFILE: PROFILE_NAME }, baseConfig(), fixture.state);
    if (!layers.ok) {
      throw new Error("the fixture's profile did not parse");
    }

    // Act
    const snapshot = snapshotOf(fixture, layers.value);

    // Assert
    expect(textOfBytes(snapshot.repoFiles.get(PROFILE_LAYER_FILE))).toBe(LAYER_BYTES);
  });

  test("should add a machine's layer file under machines/<name>/", () => {
    // Arrange
    const fixture = stateFixture();
    writeFixture(join(fixture.state, MACHINE_LAYER_FILE), LAYER_BYTES);
    const layers = loadLayers({ SYNC_MACHINE: MACHINE_NAME }, baseConfig(), fixture.state);
    if (!layers.ok) {
      throw new Error("the fixture's machine did not parse");
    }

    // Act
    const snapshot = snapshotOf(fixture, layers.value);

    // Assert
    expect(textOfBytes(snapshot.repoFiles.get(MACHINE_LAYER_FILE))).toBe(LAYER_BYTES);
  });
});
