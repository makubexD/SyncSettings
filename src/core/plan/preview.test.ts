import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2 } from "../config/types.ts";
import type { MachineRecord } from "../machine/record.ts";
import { planPreview } from "./preview.ts";
import type { LocalEntry, RepoFiles, Snapshot } from "./types.ts";

const HOME = "/home/user";

const CONFIG_PATH = "sync-config.json";

const REPO_FILE = "dotfiles/common/test/conf";

const LOCAL_FILE = "/home/user/.config/test/conf";

const MISSING_FROM_WORKING_TREE = "dotfiles/common/test/gone";

const PROFILE_NAME = "work-1";

const PROFILE_FILE = `profiles/${PROFILE_NAME}/test/conf`;

const UPPERCASE_PROFILE_FILE = "Profiles/x.json";

const UPPERCASE_MACHINE_FILE = "MACHINES/y.json";

const PROFILE: Profile = {
  name: PROFILE_NAME,
  modules: ["test"],
  values: {},
  destinations: {},
  retired: false,
};

const MATCHES_HEAD = "  Nothing would be sent: the repo matches HEAD.";

const NO_CHANGES = "  Repo is up to date. No changes detected.";

const PUSH_HEADER = "Changes on this machine:";

const CHANGED_LINE = "  1  M  test  conf  1 line(s) changed";

const CHANGES_SUMMARY = "  1 file(s) would change.";

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

const JSON_BASE_PATH = "dotfiles/common/parity/settings.json";

const JSON_OS_PATH = "dotfiles/linux/parity/settings.json";

const JSON_LOCAL_PATH = "/home/user/.config/parity/settings.json";

const JSON_CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { parity: { description: "Parity case files" } },
  entries: [
    {
      file: "parity/settings.json",
      module: "parity",
      merge: "json",
      localPath: "~/.config/parity/settings.json",
    },
  ],
};

const JSON_BASE_TEXT = '{"baseKey": 1, "delta": ["x"]}';

const JSON_OS_TEXT = '{"osKey": "linux"}';

const JSON_LOCAL_TEXT =
  '{"baseKey": 2, "osKey": "linux", "delta": ["x", "new item"]}';

const PARITY_PROFILE: Profile = {
  name: PROFILE_NAME,
  modules: ["parity"],
  values: {},
  destinations: {},
  retired: false,
};

const RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: PROFILE_NAME,
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
  claude: "claude",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const NEW_SETTINGS_TITLE = "New settings";

const NEW_SETTING_LINE = '  2  +  parity  settings.json  delta[]: "new item"';

const GOES_TO_LINE = "     goes to: profile work-1 (asked by mksync export)";

const PROFILE_SETTINGS_ADDED = "profiles/work-1/parity/settings.json";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function snapshot(
  repoFiles: RepoFiles,
  headFiles: RepoFiles,
  localBytes: Uint8Array,
  profile?: Profile,
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
    ...(profile !== undefined ? { profile } : {}),
    headFiles,
  };
}

/** A snapshot whose json entry holds a new array item, with a machine record
 * when one is given. */
function jsonPreview(record?: MachineRecord): Snapshot {
  const base = bytes(JSON_BASE_TEXT);
  const os = bytes(JSON_OS_TEXT);
  const local: LocalEntry = {
    kind: "file",
    path: JSON_LOCAL_PATH,
    bytes: bytes(JSON_LOCAL_TEXT),
    mode: 0o644,
  };
  return {
    config: JSON_CONFIG,
    os: "linux",
    home: HOME,
    cwd: HOME,
    repoFiles: new Map([
      [JSON_BASE_PATH, base],
      [JSON_OS_PATH, os],
    ]),
    localFiles: new Map([[JSON_LOCAL_PATH, local]]),
    localDirs: new Set(["/home/user/.config/parity"]),
    values: {},
    env: {},
    only: [],
    profile: PARITY_PROFILE,
    headFiles: new Map([
      [JSON_BASE_PATH, base],
      [JSON_OS_PATH, os],
    ]),
    ...(record !== undefined ? { record } : {}),
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

  test("should say nothing would be sent when a profile layer file is unchanged", () => {
    // Arrange
    const layerBytes = bytes("same\n");
    const repoFiles = new Map([[PROFILE_FILE, layerBytes]]);
    const headFiles = new Map<string, Uint8Array>();
    const preview = snapshot(repoFiles, headFiles, layerBytes, PROFILE);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NO_CHANGES);
    expect(result.lines).toContain(MATCHES_HEAD);
  });

  test("should say nothing would be sent when only a profile layer file would change", () => {
    // Arrange
    const repoFiles = new Map([[PROFILE_FILE, bytes("old\n")]]);
    const headFiles = new Map<string, Uint8Array>();
    const preview = snapshot(repoFiles, headFiles, bytes("new\n"), PROFILE);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NO_CHANGES);
    expect(result.lines).toContain(MATCHES_HEAD);
  });

  test("should print the grouped block when the export would change a file", () => {
    // Arrange
    const repoFile = bytes("old\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([[REPO_FILE, repoFile]]);
    const preview = snapshot(repoFiles, headFiles, bytes("new\n"));

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(PUSH_HEADER);
    expect(result.lines).toContain("All machines");
    expect(result.lines).toContain(CHANGED_LINE);
    expect(result.lines).toContain("Linux machines");
    expect(result.lines).toContain("     (none)");
    expect(result.lines.indexOf(PUSH_HEADER)).toBeLessThan(
      result.lines.indexOf(CHANGES_SUMMARY),
    );
  });

  test("should print no grouped block when the export would change nothing", () => {
    // Arrange
    const repoFile = bytes("same\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([[REPO_FILE, repoFile]]);
    const preview = snapshot(repoFiles, headFiles, repoFile);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NO_CHANGES);
    expect(result.lines).not.toContain(PUSH_HEADER);
    expect(result.lines).not.toContain("All machines");
  });

  test("should list a new setting with its goes-to line and the suggestion's layer in the status lines", () => {
    // Arrange
    const preview = jsonPreview(RECORD);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines).toContain(NEW_SETTINGS_TITLE);
    expect(result.lines).toContain(NEW_SETTING_LINE);
    expect(result.lines).toContain(GOES_TO_LINE);
    expect(result.lines).toContain(
      `  ADDED      ${PROFILE_SETTINGS_ADDED}`,
    );
    expect(result.lines.some((line) => line.includes("ERROR"))).toBe(false);
  });

  test.each([
    [UPPERCASE_PROFILE_FILE],
    [UPPERCASE_MACHINE_FILE],
  ])(
    "should leave %s out of the count and the compared tree",
    (stateFile) => {
      // Arrange
      const repoFiles = new Map([
        [PROFILE_FILE, bytes("new\n")],
        [stateFile, bytes("new\n")],
      ]);
      const headFiles = new Map<string, Uint8Array>();
      const preview = snapshot(repoFiles, headFiles, bytes("same\n"), PROFILE);

      // Act
      const result = planPreview(preview);

      // Assert
      expect(result.code).toBe(0);
      expect(result.lines).toContain(NO_CHANGES);
      expect(result.lines).toContain(MATCHES_HEAD);
    },
  );
});
