import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Profile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  Result as LoadResult,
} from "../core/config/types.ts";
import type { FirstBackupWrites } from "../core/machine/backup.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import type { FirstBackupFile, Store } from "./store.ts";
import {
  firstBackupFiles,
  readBackupSides,
  readRepoStore,
  readStore,
  writeFirstBackup,
  writeProfile,
  writeRecord,
  writeStoreProfile,
  writeStoreRecord,
} from "./store.ts";

const MACHINE_NAME = "wk1-laptop";

const OTHER_MACHINE_NAME = "wk1-desktop";

const PROFILE_NAME = "work-1";

const OTHER_PROFILE_NAME = "personal";

const EMPTY_PROFILE_TEXT = "{}\n";

const PROFILE_TEXT = '{"modules":["base"]}\n';

const MISSING_PROFILE_MESSAGE = `ERROR: profile ${PROFILE_NAME} not found: `;

const BAD_RECORD_MESSAGE =
  "ERROR: machine record (machine.json in the state folder): unknown field extra.";

const UNREADABLE_RECORD_MESSAGE =
  "ERROR: machine record (machine.json in the state folder): can't be read.";

function unreadableProfileMessage(name: string): string {
  return `ERROR: profile ${name} (profiles/${name}.json in the state folder): can't be read.`;
}

const NO_PERMISSIONS = 0o000;

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

function expectOk<T>(result: LoadResult<T, ConfigError>): T {
  if (!result.ok) {
    throw new Error(`expected a store, got ${result.error.message}`);
  }
  return result.value;
}

function expectError<T>(result: LoadResult<T, ConfigError>): ConfigError {
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

  test("should report the record line and code 2 when machine.json is a folder", () => {
    // Arrange
    const fixture = storeFixture();
    mkdirSync(join(fixture.state, "machine.json"));

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(UNREADABLE_RECORD_MESSAGE);
    expect(error.code).toBe(2);
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

  test.skipIf(process.getuid?.() === 0)(
    "should report the profile can't-be-read line and code 2 when the profile file can't be read",
    () => {
      // Arrange
      const fixture = storeFixture();
      writeFixture(
        join(fixture.state, "machine.json"),
        recordText(MACHINE_NAME, PROFILE_NAME),
      );
      const profilePath = join(
        fixture.state,
        "profiles",
        `${PROFILE_NAME}.json`,
      );
      writeFixture(profilePath, PROFILE_TEXT);
      chmodSync(profilePath, NO_PERMISSIONS);

      // Act
      const error = expectError(storeOf(fixture));

      // Assert
      expect(error.message).toBe(unreadableProfileMessage(PROFILE_NAME));
      expect(error.code).toBe(2);
    },
  );

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

  test("should report the repo can't-be-read line and code 2 when a pointer's repo record is not JSON", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );
    writeFixture(
      join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
      "not json",
    );

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(
      `ERROR: machines/${MACHINE_NAME}.json can't be read: not valid JSON.`,
    );
    expect(error.code).toBe(2);
  });

  test("should return every repo record for used-by and the repo record file when the record is a pointer", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );
    for (const name of [OTHER_MACHINE_NAME, MACHINE_NAME]) {
      writeFixture(
        join(fixture.repo, "machines", `${name}.json`),
        recordText(name, PROFILE_NAME),
      );
    }
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );

    // Act
    const store = expectOk(
      readStore(fixture.state, fixture.repo, baseConfig(), { usedBy: true }),
    );

    // Assert
    expect(store.records.map((record) => record.name)).toEqual([
      OTHER_MACHINE_NAME,
      MACHINE_NAME,
    ]);
    expect(store.location.recordFile).toBe(
      join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
    );
    expect(store.location.profilesFolder).toBe(join(fixture.repo, "profiles"));
  });

  test("should read only this machine's record and profile when another repo record isn't JSON", () => {
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
      join(fixture.repo, "machines", `${OTHER_MACHINE_NAME}.json`),
      "not json",
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );

    // Act
    const store = expectOk(storeOf(fixture));

    // Assert
    expect(store.record?.name).toBe(MACHINE_NAME);
    expect(store.profile?.name).toBe(PROFILE_NAME);
    expect(store.profile?.modules).toEqual(["base"]);
    expect(store.records.map((record) => record.name)).toEqual([MACHINE_NAME]);
  });

  test("should report another repo record's read reason for profile retire's used-by read", () => {
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
      join(fixture.repo, "machines", `${OTHER_MACHINE_NAME}.json`),
      "not json",
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );

    // Act
    const error = expectError(
      readStore(fixture.state, fixture.repo, baseConfig(), { usedBy: true }),
    );

    // Assert
    expect(error.message).toBe(
      `ERROR: machines/${OTHER_MACHINE_NAME}.json can't be read: not valid JSON.`,
    );
    expect(error.code).toBe(2);
  });

  test("should name this machine's repo record read reason once when it isn't JSON", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );
    writeFixture(
      join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
      "not json",
    );

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(
      `ERROR: machines/${MACHINE_NAME}.json can't be read: not valid JSON.`,
    );
    expect(error.code).toBe(2);
  });

  test("should give the read error as the reason when this machine's repo record is a folder", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );
    mkdirSync(join(fixture.repo, "machines", `${MACHINE_NAME}.json`), {
      recursive: true,
    });

    // Act
    const error = expectError(storeOf(fixture));

    // Assert
    expect(error.message).toBe(
      `ERROR: machines/${MACHINE_NAME}.json can't be read: a folder in its place.`,
    );
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

const PRIVATE_MODE = 0o600;

const RECORD_VALUES = { "<HOME>": "C:\\Users\\user" };

const PROFILE_VALUES = { "<YOUR_EMAIL>": "work@example.com" };

function recordOf(): MachineRecord {
  return {
    name: MACHINE_NAME,
    profile: PROFILE_NAME,
    os: "windows",
    hostname: MACHINE_NAME,
    domain: "corp.example.com",
    claude: "claude",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: RECORD_VALUES,
    replaced: [],
    retired: false,
  };
}

function profileOf(): Profile {
  return {
    name: PROFILE_NAME,
    modules: ["base"],
    values: PROFILE_VALUES,
    destinations: {},
    retired: false,
  };
}

describe("writeRecord and writeProfile", () => {
  test("should write a record and profile readStore reads back", () => {
    // Arrange
    const fixture = storeFixture();

    // Act
    writeRecord(fixture.state, recordOf());
    writeProfile(fixture.state, profileOf());
    const store = expectOk(storeOf(fixture));

    // Assert
    expect(store.record).toEqual(recordOf());
    expect(store.profile).toEqual(profileOf());
    expect(store.profiles).toEqual([profileOf()]);
  });

  test("should write both files for the current user only", () => {
    // Arrange
    const fixture = storeFixture();

    // Act
    writeRecord(fixture.state, recordOf());
    writeProfile(fixture.state, profileOf());
    const recordMode = statSync(join(fixture.state, "machine.json")).mode;
    const profileMode = statSync(
      join(fixture.state, "profiles", `${PROFILE_NAME}.json`),
    ).mode;

    // Assert
    expect(recordMode & 0o777).toBe(PRIVATE_MODE);
    expect(profileMode & 0o777).toBe(PRIVATE_MODE);
  });
});

describe("writeStoreRecord and writeStoreProfile", () => {
  const POINTER_TEXT = JSON.stringify({ name: MACHINE_NAME, home: "repo" });

  function pointerFixture(): StoreFixture {
    const fixture = storeFixture();
    writeFixture(join(fixture.state, "machine.json"), POINTER_TEXT);
    writeFixture(
      join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
      recordText(MACHINE_NAME, PROFILE_NAME),
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );
    return fixture;
  }

  test("should write a retired pointer record to the repo and leave the state pointer as it is", () => {
    // Arrange
    const fixture = pointerFixture();
    const store = expectOk(storeOf(fixture));
    const record = store.record;
    if (record === undefined) {
      throw new Error("expected a record");
    }

    // Act
    writeStoreRecord(store.location, { ...record, retired: true });

    // Assert
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ retired: true });
    expect(readFileSync(join(fixture.state, "machine.json"), "utf8")).toBe(
      POINTER_TEXT,
    );
  });

  test("should write a retired pointer profile to the repo and leave the state folder as it is", () => {
    // Arrange
    const fixture = pointerFixture();
    const store = expectOk(storeOf(fixture));
    const profile = store.profile;
    if (profile === undefined) {
      throw new Error("expected a profile");
    }

    // Act
    writeStoreProfile(store.location, { ...profile, retired: true });

    // Assert
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ retired: true });
    expect(existsSync(join(fixture.state, "profiles"))).toBe(false);
  });
});

describe("readRepoStore", () => {
  test("should read every machine record and profile from the repo", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.repo, "machines", `${MACHINE_NAME}.json`),
      recordText(MACHINE_NAME, PROFILE_NAME),
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );

    // Act
    const repo = expectOk(readRepoStore(fixture.repo, baseConfig()));

    // Assert
    expect(repo.records.map((record) => record.name)).toEqual([MACHINE_NAME]);
    expect(repo.profiles.map((profile) => profile.name)).toEqual([
      PROFILE_NAME,
    ]);
    expect(repo.profiles[0]?.modules).toEqual(["base"]);
  });
});

const LAYER_TEXT = '{"profileKey":true}\n';

const PROFILE_LAYER_FILE = "parity/settings.json";

const MACHINE_LAYER_FILE = "base/platform.json";

describe("readBackupSides", () => {
  test("should read both layer folders relative and the repo's profile", () => {
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
    writeFixture(
      join(fixture.state, "profiles", PROFILE_NAME, PROFILE_LAYER_FILE),
      LAYER_TEXT,
    );
    writeFixture(
      join(fixture.state, "machines", MACHINE_NAME, MACHINE_LAYER_FILE),
      LAYER_TEXT,
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      PROFILE_TEXT,
    );

    // Act
    const sides = expectOk(
      readBackupSides(fixture.state, fixture.repo, baseConfig()),
    );

    // Assert
    expect(sides?.local.profileLayer).toEqual([
      { path: PROFILE_LAYER_FILE, text: LAYER_TEXT },
    ]);
    expect(sides?.local.machineLayer).toEqual([
      { path: MACHINE_LAYER_FILE, text: LAYER_TEXT },
    ]);
    expect(sides?.repo.profile?.modules).toEqual(["base"]);
  });

  test("should return no sides when the record is already the pointer", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      JSON.stringify({ name: MACHINE_NAME, home: "repo" }),
    );

    // Act
    const sides = expectOk(
      readBackupSides(fixture.state, fixture.repo, baseConfig()),
    );

    // Assert
    expect(sides).toBeUndefined();
  });

  test("should return no sides when there is no record", () => {
    // Arrange
    const fixture = storeFixture();

    // Act
    const sides = expectOk(
      readBackupSides(fixture.state, fixture.repo, baseConfig()),
    );

    // Assert
    expect(sides).toBeUndefined();
  });
});

function backupWrites(): FirstBackupWrites {
  return {
    profile: profileOf(),
    record: recordOf(),
    files: [
      {
        path: `profiles/${PROFILE_NAME}/${PROFILE_LAYER_FILE}`,
        text: LAYER_TEXT,
      },
    ],
  };
}

function relativeProfilePath(): string {
  return `profiles/${PROFILE_NAME}.json`;
}

function relativeMachinePath(): string {
  return `machines/${MACHINE_NAME}.json`;
}

function backupFile(
  path: string,
  text: string,
  status: FirstBackupFile["status"],
): FirstBackupFile {
  return { path, text, status };
}

describe("firstBackupFiles", () => {
  test("should mark every file ADDED when the repo holds none", () => {
    // Arrange
    const fixture = storeFixture();

    // Act
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Assert
    expect(files.map((file) => file.path)).toEqual([
      `machines/${MACHINE_NAME}.json`,
      `profiles/${PROFILE_NAME}.json`,
      `profiles/${PROFILE_NAME}/${PROFILE_LAYER_FILE}`,
    ]);
    expect(files.map((file) => file.status)).toEqual([
      "ADDED",
      "ADDED",
      "ADDED",
    ]);
  });

  test("should leave out a file the repo already holds identical bytes for", () => {
    // Arrange
    const fixture = storeFixture();
    const first = firstBackupFiles(fixture.repo, backupWrites());
    const profile = first.find(
      (file) => file.path === `profiles/${PROFILE_NAME}.json`,
    );
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      profile?.text ?? "",
    );

    // Act
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Assert
    expect(files.map((file) => file.path)).toEqual([
      `machines/${MACHINE_NAME}.json`,
      `profiles/${PROFILE_NAME}/${PROFILE_LAYER_FILE}`,
    ]);
  });

  test("should mark a differing repo file MODIFIED", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
      EMPTY_PROFILE_TEXT,
    );

    // Act
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Assert
    const profile = files.find(
      (file) => file.path === `profiles/${PROFILE_NAME}.json`,
    );
    expect(profile?.status).toBe("MODIFIED");
  });
});

describe("writeFirstBackup", () => {
  test("should write the files and then make machine.json the pointer", () => {
    // Arrange
    const fixture = storeFixture();
    writeFixture(
      join(fixture.state, "machine.json"),
      recordText(MACHINE_NAME, PROFILE_NAME),
    );
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Act
    const written = writeFirstBackup(
      fixture.state,
      fixture.repo,
      MACHINE_NAME,
      files,
    );

    // Assert
    expect(written.ok).toBe(true);
    expect(
      JSON.parse(readFileSync(join(fixture.state, "machine.json"), "utf8")),
    ).toEqual({ name: MACHINE_NAME, home: "repo" });
    expect(
      readFileSync(
        join(fixture.repo, "profiles", `${PROFILE_NAME}.json`),
        "utf8",
      ),
    ).toBe(
      files.find((file) => file.path === `profiles/${PROFILE_NAME}.json`)
        ?.text ?? "",
    );
    expect(statSync(join(fixture.state, "machine.json")).mode & 0o777).toBe(
      PRIVATE_MODE,
    );
  });

  test("should leave machine.json as it was when a write fails", () => {
    // Arrange
    const fixture = storeFixture();
    const original = recordText(MACHINE_NAME, PROFILE_NAME);
    writeFixture(join(fixture.state, "machine.json"), original);
    // A folder where the profile's file goes makes the write fail.
    mkdirSync(join(fixture.repo, "profiles", `${PROFILE_NAME}.json`), {
      recursive: true,
    });
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Act
    const failed = expectError(
      writeFirstBackup(fixture.state, fixture.repo, MACHINE_NAME, files),
    );

    // Assert
    expect(failed.code).toBe(1);
    expect(
      failed.message.startsWith(
        `ERROR: first backup stopped at profiles/${PROFILE_NAME}.json:`,
      ),
    ).toBe(true);
    expect(readFileSync(join(fixture.state, "machine.json"), "utf8")).toBe(
      original,
    );
  });

  test("should refuse a machines folder that is a symlink and write nothing through it", () => {
    // Arrange
    const fixture = storeFixture();
    const elsewhere = tempFolder();
    symlinkSync(elsewhere, join(fixture.repo, "machines"));
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Act
    const failed = expectError(
      writeFirstBackup(fixture.state, fixture.repo, MACHINE_NAME, files),
    );

    // Assert
    expect(failed.code).toBe(1);
    expect(failed.message).toBe(
      `ERROR: first backup stopped at machines/${MACHINE_NAME}.json: a symlink.`,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(fixture.state, "machine.json"))).toBe(false);
  });

  test("should refuse a layer file that is a symlink and leave its target unchanged", () => {
    // Arrange
    const fixture = storeFixture();
    const target = join(tempFolder(), "settings.json");
    writeFixture(target, EMPTY_PROFILE_TEXT);
    const link = join(
      fixture.repo,
      "profiles",
      PROFILE_NAME,
      PROFILE_LAYER_FILE,
    );
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    const files = firstBackupFiles(fixture.repo, backupWrites());

    // Act
    const failed = expectError(
      writeFirstBackup(fixture.state, fixture.repo, MACHINE_NAME, files),
    );

    // Assert
    expect(failed.code).toBe(1);
    expect(failed.message).toBe(
      `ERROR: first backup stopped at profiles/${PROFILE_NAME}/${PROFILE_LAYER_FILE}: a symlink.`,
    );
    expect(readFileSync(target, "utf8")).toBe(EMPTY_PROFILE_TEXT);
    expect(
      existsSync(join(fixture.repo, "machines", `${MACHINE_NAME}.json`)),
    ).toBe(false);
  });

  test("should remove a file the backup added when a later write fails", () => {
    // Arrange
    const fixture = storeFixture();
    const profilePath = join(fixture.repo, "profiles", `${PROFILE_NAME}.json`);
    // A regular file where the machines folder goes makes the second write fail.
    writeFixture(join(fixture.repo, "machines"), "not a folder");
    const files = [
      backupFile(relativeProfilePath(), PROFILE_TEXT, "ADDED"),
      backupFile(
        relativeMachinePath(),
        recordText(MACHINE_NAME, PROFILE_NAME),
        "ADDED",
      ),
    ];

    // Act
    const failed = expectError(
      writeFirstBackup(fixture.state, fixture.repo, MACHINE_NAME, files),
    );

    // Assert
    expect(failed.code).toBe(1);
    expect(
      failed.message.startsWith("ERROR: first backup stopped at machines/"),
    ).toBe(true);
    expect(existsSync(profilePath)).toBe(false);
  });

  test("should restore a file the backup modified when a later write fails", () => {
    // Arrange
    const fixture = storeFixture();
    const profilePath = join(fixture.repo, "profiles", `${PROFILE_NAME}.json`);
    writeFixture(profilePath, EMPTY_PROFILE_TEXT);
    // A regular file where the machines folder goes makes the second write fail.
    writeFixture(join(fixture.repo, "machines"), "not a folder");
    const files = [
      backupFile(relativeProfilePath(), PROFILE_TEXT, "MODIFIED"),
      backupFile(
        relativeMachinePath(),
        recordText(MACHINE_NAME, PROFILE_NAME),
        "ADDED",
      ),
    ];

    // Act
    const failed = expectError(
      writeFirstBackup(fixture.state, fixture.repo, MACHINE_NAME, files),
    );

    // Assert
    expect(failed.code).toBe(1);
    expect(
      failed.message.startsWith("ERROR: first backup stopped at machines/"),
    ).toBe(true);
    expect(readFileSync(profilePath, "utf8")).toBe(EMPTY_PROFILE_TEXT);
  });
});
