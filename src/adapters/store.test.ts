import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ConfigError,
  ConfigV2,
  Result as LoadResult,
} from "../core/config/types.ts";
import type { Store } from "./store.ts";
import { readStore } from "./store.ts";

const MACHINE_NAME = "wk1-laptop";

const PROFILE_NAME = "work-1";

const OTHER_PROFILE_NAME = "personal";

const EMPTY_PROFILE_TEXT = "{}\n";

const PROFILE_TEXT = '{"modules":["base"]}\n';

const MISSING_PROFILE_MESSAGE = `ERROR: profile ${PROFILE_NAME} not found: `;

const BAD_RECORD_MESSAGE =
  "ERROR: machine record (machine.json in the state folder): unknown field extra.";

const MISSING_MACHINE_MESSAGE = `ERROR: machine ${MACHINE_NAME} not found: machines/${MACHINE_NAME}.json`;

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-store-"));
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

function writeFixture(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

interface StoreFixture {
  readonly repo: string;
  readonly state: string;
}

/** Throwaway repo and state folders, never the real ones. */
function storeFixture(): StoreFixture {
  const root = tempFolder();
  const repo = join(root, "repo");
  const state = join(root, "state");
  for (const folder of [repo, state]) {
    mkdirSync(folder, { recursive: true });
  }
  return { repo, state };
}

function baseConfig(): ConfigV2 {
  return {
    schemaVersion: 2,
    modules: { base: { description: "Base" } },
    entries: [],
  };
}

/** A full record in the contract's field set, redacted. */
function recordText(name: string, profile: string): string {
  return JSON.stringify({
    name,
    profile,
    os: "windows",
    hostname: name,
    domain: "corp.example.com",
    claude: "claude",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: {},
    replaced: [],
    retired: false,
  });
}

function storeOf(fixture: StoreFixture): LoadResult<Store, ConfigError> {
  return readStore(fixture.state, fixture.repo, baseConfig());
}

function expectOk(result: LoadResult<Store, ConfigError>): Store {
  if (!result.ok) {
    throw new Error(`expected a store, got ${result.error.message}`);
  }
  return result.value;
}

function expectError(result: LoadResult<Store, ConfigError>): ConfigError {
  if (result.ok) {
    throw new Error("expected an error");
  }
  return result.error;
}

describe("readStore", () => {
  test("should return no record and no profiles when the state folder is empty", () => {
    // Arrange
    const fixture = storeFixture();

    // Act
    const store = expectOk(storeOf(fixture));

    // Assert
    expect(store.record).toBeUndefined();
    expect(store.profile).toBeUndefined();
    expect(store.profiles).toEqual([]);
  });

  test("should return every local profile sorted by name when there is no record", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );
    writeFixture(
      join(fixture.state, "profiles", `${OTHER_PROFILE_NAME}.json`),
      EMPTY_PROFILE_TEXT,
    );

    // Act
    const store = expectOk(storeOf(fixture));

    // Assert
    expect(store.record).toBeUndefined();
    expect(store.profile).toBeUndefined();
    expect(store.profiles.map((profile) => profile.name)).toEqual([
      OTHER_PROFILE_NAME,
      PROFILE_NAME,
    ]);
    expect(store.profiles[1]?.modules).toEqual(["base"]);
  });

  test("should return the local record, its profile and every profile when a local record exists", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      recordText(MACHINE_NAME, PROFILE_NAME),
    );
    writeFixture(
      join(fixture.state, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );

    // Act
    const store = expectOk(storeOf(fixture));

    // Assert
    expect(store.record?.name).toBe(MACHINE_NAME);
    expect(store.profile?.name).toBe(PROFILE_NAME);
    expect(store.profile?.modules).toEqual(["base"]);
    expect(store.profiles.map((profile) => profile.name)).toEqual([
      PROFILE_NAME,
    ]);
  });

  test("should report the missing profile of a local record with its path and code 2", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      recordText(MACHINE_NAME, PROFILE_NAME),
    );
    const missingPath = join(fixture.state, "profiles", `${PROFILE_NAME}.json`);

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(`${MISSING_PROFILE_MESSAGE}${missingPath}`);
    expect(error.code).toBe(2);
  });

  test("should return the record line and code 2 when the local record has an unknown field", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({
        name: MACHINE_NAME,
        profile: PROFILE_NAME,
        os: "windows",
        hostname: MACHINE_NAME,
        domain: "corp.example.com",
        claude: "claude",
        pullOnly: false,
        modules: { add: [], remove: [] },
        values: {},
        replaced: [],
        retired: false,
        extra: true,
      }),
    );

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(BAD_RECORD_MESSAGE);
    expect(error.code).toBe(2);
  });

  test("should read the record and profiles from the repo when the record is a repo-home pointer", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );
    writeFixture(
      join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
      recordText(MACHINE_NAME, PROFILE_NAME),
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );
    writeFixture(
      join(fixture.state, "profiles", `${PROFILE_NAME}.json`),
      EMPTY_PROFILE_TEXT,
    );

    // Act
    const store = expectOk(storeOf(fixture));

    // Assert
    expect(store.record?.name).toBe(MACHINE_NAME);
    expect(store.profile?.modules).toEqual(["base"]);
    expect(store.profiles.map((profile) => profile.name)).toEqual([
      PROFILE_NAME,
    ]);
    expect(store.profiles[0]?.modules).toEqual(["base"]);
  });

  test("should report a missing repo machine file for a repo-home pointer with code 2", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(MISSING_MACHINE_MESSAGE);
    expect(error.code).toBe(2);
  });
});
