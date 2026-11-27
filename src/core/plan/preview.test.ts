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

const VALUE_PLACEHOLDER = "<YOUR_EMAIL>";

const PROFILE_VALUE = "jane@work1.example.com";

const PROFILE_WITH_VALUE: Profile = {
  ...PROFILE,
  values: { [VALUE_PLACEHOLDER]: PROFILE_VALUE },
};

const REFUSED_LINE = `refused: change 1 (test conf) holds a value of profile ${PROFILE_NAME} (${VALUE_PLACEHOLDER}) and would reach all machines.`;

const REFUSED_ADVICE = `Move it to "profile ${PROFILE_NAME}", or put ${VALUE_PLACEHOLDER} in the file instead.`;

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

const DIR_CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {},
  entries: [
    {
      file: "test",
      module: "test",
      merge: "dir",
      localPath: "~/.config/test",
    },
  ],
};

const DIR_LOCAL_PATH = "/home/user/.config/test";

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

const DECODER = new TextDecoder();

function text(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : DECODER.decode(value);
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

  test("should refuse when a base write holds a profile value", () => {
    // Arrange
    const base = bytes('{"email": "old@example.com"}');
    const repoFiles = new Map([[REPO_FILE, base]]);
    const headFiles = new Map([[REPO_FILE, base]]);
    const preview = snapshot(
      repoFiles,
      headFiles,
      bytes(`{"email": "${PROFILE_VALUE}"}`),
      PROFILE_WITH_VALUE,
    );

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(1);
    expect(result.lines).toContain(PUSH_HEADER);
    expect(result.lines.slice(-2)).toEqual([REFUSED_LINE, REFUSED_ADVICE]);
  });

  test("should print no refused lines when no shared-layer write holds a profile value", () => {
    // Arrange
    const repoFile = bytes("old\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([[REPO_FILE, repoFile]]);
    const preview = snapshot(
      repoFiles,
      headFiles,
      bytes("new\n"),
      PROFILE_WITH_VALUE,
    );

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.lines.some((line) => line.startsWith("refused:"))).toBe(
      false,
    );
    expect(result.lines).toContain(CHANGES_SUMMARY);
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
    expect(result.lines).toContain(`  ADDED      ${PROFILE_SETTINGS_ADDED}`);
    expect(result.lines.some((line) => line.includes("ERROR"))).toBe(false);
  });

  test.each([[UPPERCASE_PROFILE_FILE], [UPPERCASE_MACHINE_FILE]])(
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

  test("should hand the app the tree an export would leave", () => {
    // Arrange
    const repoFile = bytes("old\n");
    const untouched = bytes("keep\n");
    const repoFiles = new Map([
      [REPO_FILE, repoFile],
      [UPPERCASE_PROFILE_FILE, untouched],
    ]);
    const headFiles = new Map([[REPO_FILE, repoFile]]);
    const preview = snapshot(repoFiles, headFiles, bytes("new\n"));

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(text(result.tree?.get(REPO_FILE))).toBe("new\n");
    expect(text(result.tree?.get(UPPERCASE_PROFILE_FILE))).toBe("keep\n");
  });

  test("should keep sync-config.json in the tree when a working tree is passed", () => {
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
    expect(text(result.tree?.get(CONFIG_PATH))).toBe("{}\n");
    expect(text(result.tree?.get(REPO_FILE))).toBe("same\n");
  });

  test("should leave a removed file out of the tree", () => {
    // Arrange
    const kept = bytes("same\n");
    const repoFiles = new Map([
      [REPO_FILE, kept],
      [MISSING_FROM_WORKING_TREE, bytes("gone\n")],
    ]);
    const local: LocalEntry = {
      kind: "file",
      path: LOCAL_FILE,
      bytes: kept,
      mode: 0o644,
    };
    const preview: Snapshot = {
      config: DIR_CONFIG,
      os: "linux",
      home: HOME,
      cwd: HOME,
      repoFiles,
      localFiles: new Map([[LOCAL_FILE, local]]),
      localDirs: new Set([DIR_LOCAL_PATH]),
      values: {},
      env: {},
      only: [],
      headFiles: repoFiles,
    };

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.tree?.has(REPO_FILE)).toBe(true);
    expect(result.tree?.has(MISSING_FROM_WORKING_TREE)).toBe(false);
  });

  test("should carry no tree when --only refuses the preview", () => {
    // Arrange
    const repoFile = bytes("same\n");
    const repoFiles = new Map([[REPO_FILE, repoFile]]);
    const headFiles = new Map([[REPO_FILE, repoFile]]);
    const preview: Snapshot = {
      ...snapshot(repoFiles, headFiles, repoFile),
      only: [REPO_FILE],
    };

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(1);
    expect(result.tree).toBeUndefined();
  });
});

describe("planPreview with a missing value", () => {
  const NAME_PLACEHOLDER = "<YOUR_NAME>";
  const EMAIL_PLACEHOLDER = "<YOUR_EMAIL>";
  const NAME_REPO = "dotfiles/common/test/name.conf";
  const EMAIL_REPO = "dotfiles/common/test/email.conf";
  const PLAIN_REPO = "dotfiles/common/test/plain.conf";
  const NAME_LOCAL = `${HOME}/.config/test/name.conf`;
  const EMAIL_LOCAL = `${HOME}/.config/test/email.conf`;
  const PLAIN_LOCAL = `${HOME}/.config/test/plain.conf`;
  const NAME_REPO_TEXT = "name = <YOUR_NAME>\n";
  const EMAIL_REPO_TEXT = "email = <YOUR_EMAIL>\n";
  const PLAIN_REPO_TEXT = "color = red\n";
  const NAME_LOCAL_TEXT = "name: Ana Lopez\n";
  const EMAIL_LOCAL_TEXT = "email: ana@example.com\n";
  const PLAIN_LOCAL_TEXT = "color = blue\n";
  const NAME_SKIPPED = `  SKIPPED    ${NAME_REPO}  (needs ${NAME_PLACEHOLDER}: mksync push asks for it)`;
  const EMAIL_SKIPPED = `  SKIPPED    ${EMAIL_REPO}  (needs ${EMAIL_PLACEHOLDER}: mksync push asks for it)`;
  const PLAIN_MODIFIED = `  MODIFIED   ${PLAIN_REPO}`;

  function fileEntry(
    name: string,
    placeholder?: string,
  ): ConfigV2["entries"][number] {
    return {
      file: `test/${name}`,
      module: "test",
      merge: "whole",
      localPath: `~/.config/test/${name}`,
      ...(placeholder === undefined
        ? {}
        : { sanitize: [{ placeholder, prompt: "Value" }] }),
    };
  }

  function localFile(path: string, content: string): [string, LocalEntry] {
    return [path, { kind: "file", path, bytes: bytes(content), mode: 0o644 }];
  }

  function gapSnapshot(withEmail: boolean): Snapshot {
    const repoFiles = new Map([
      [NAME_REPO, bytes(NAME_REPO_TEXT)],
      [PLAIN_REPO, bytes(PLAIN_REPO_TEXT)],
      ...(withEmail ? [[EMAIL_REPO, bytes(EMAIL_REPO_TEXT)] as const] : []),
    ]);
    return {
      config: {
        schemaVersion: 2,
        modules: {},
        entries: [
          fileEntry("name.conf", NAME_PLACEHOLDER),
          ...(withEmail ? [fileEntry("email.conf", EMAIL_PLACEHOLDER)] : []),
          fileEntry("plain.conf"),
        ],
      },
      os: "linux",
      home: HOME,
      cwd: HOME,
      repoFiles,
      localFiles: new Map([
        localFile(NAME_LOCAL, NAME_LOCAL_TEXT),
        localFile(PLAIN_LOCAL, PLAIN_LOCAL_TEXT),
        ...(withEmail ? [localFile(EMAIL_LOCAL, EMAIL_LOCAL_TEXT)] : []),
      ]),
      localDirs: new Set(),
      values: {},
      env: {},
      only: [],
      headFiles: new Map(repoFiles),
    };
  }

  test("should skip only the file that needs the value and exit 1", () => {
    // Arrange
    const preview = gapSnapshot(false);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(1);
    expect(result.skipped).toBe(true);
    expect(result.lines.slice(0, 2)).toEqual([NAME_SKIPPED, PLAIN_MODIFIED]);
  });

  test("should leave the skipped file out of the tree", () => {
    // Arrange
    const preview = gapSnapshot(false);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(text(result.tree?.get(NAME_REPO))).toBe(NAME_REPO_TEXT);
    expect(text(result.tree?.get(PLAIN_REPO))).toBe(PLAIN_LOCAL_TEXT);
  });

  test("should name each missing placeholder on its own file", () => {
    // Arrange
    const preview = gapSnapshot(true);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.lines.slice(0, 3)).toEqual([
      NAME_SKIPPED,
      EMAIL_SKIPPED,
      PLAIN_MODIFIED,
    ]);
  });

  const WAITING_ONE =
    "  1 file(s) would change; 1 more wait(s) for a value (mksync push asks for it).";
  const WAITING_TWO =
    "  1 file(s) would change; 2 more wait(s) for a value (mksync push asks for it).";
  const WAITING_ONLY =
    "  0 file(s) would change; 1 more wait(s) for a value (mksync push asks for it).";

  test("should count the waiting file after the files that would change", () => {
    // Arrange
    const preview = gapSnapshot(false);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.lines).toContain(WAITING_ONE);
  });

  test("should count every waiting file in the summary", () => {
    // Arrange
    const preview = gapSnapshot(true);

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.lines).toContain(WAITING_TWO);
  });

  test("should count the waiting file when no other file would change", () => {
    // Arrange
    const preview: Snapshot = {
      ...gapSnapshot(false),
      localFiles: new Map([
        localFile(NAME_LOCAL, NAME_LOCAL_TEXT),
        localFile(PLAIN_LOCAL, PLAIN_REPO_TEXT),
      ]),
    };

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.lines).toContain(WAITING_ONLY);
    expect(result.lines).not.toContain(NO_CHANGES);
  });

  test("should keep the plain summary when no value is missing", () => {
    // Arrange
    const preview: Snapshot = {
      ...gapSnapshot(false),
      values: { [NAME_PLACEHOLDER]: "Ana Lopez" },
    };

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.lines).toContain("  2 file(s) would change.");
  });

  test("should preview as before when no value is missing", () => {
    // Arrange
    const preview: Snapshot = {
      ...gapSnapshot(false),
      values: { [NAME_PLACEHOLDER]: "Ana Lopez" },
    };

    // Act
    const result = planPreview(preview);

    // Assert
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(false);
    expect(result.lines.some((line) => line.includes("SKIPPED"))).toBe(false);
  });
});
