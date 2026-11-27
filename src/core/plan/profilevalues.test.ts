import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { MachineRecord } from "../machine/record.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { changeLines } from "./changes.ts";
import { holdsToken, profileValueHits, refusedLines } from "./profilevalues.ts";
import type { Action, RunPlan, Snapshot } from "./types.ts";

const HOME = "/home/user";

const PROFILE_NAME = "work-1";

const MODE = 0o644;

const BASE_JSON = "dotfiles/common/parity/settings.json";

const OS_JSON = "dotfiles/linux/parity/settings.json";

const PROFILE_JSON = `profiles/${PROFILE_NAME}/parity/settings.json`;

const OLD_JSON = '{"email":"old@example.com"}';

const NEW_JSON = '{"email":"jane@work1.example.com"}';

const UPPER_JSON = '{"email":"JANE@WORK1.EXAMPLE.COM"}';

const SANITIZED_JSON = '{"email":"<YOUR_EMAIL>"}';

const PROFILE_VALUE = "jane@work1.example.com";

const PLACEHOLDER = "<YOUR_EMAIL>";

const JSON_ENTRY: ConfigV2Entry = {
  file: "parity/settings.json",
  module: "parity",
  merge: "json",
  localPath: "~/.config/parity/settings.json",
  description: "Parity JSON settings",
};

const WHOLE_ENTRY: ConfigV2Entry = {
  file: "parity/profile.sh",
  module: "parity",
  merge: "whole",
  localPath: "~/.config/parity/profile.sh",
  description: "Parity whole file",
};

const WHOLE_PATH = "dotfiles/common/parity/profile.sh";

const IMPORT_ENTRY: ConfigV2Entry = {
  file: "parity/notes.json",
  module: "parity",
  merge: "import",
  localPath: "~/.config/parity/notes.json",
  description: "Parity import file",
};

const IMPORT_PATH = "dotfiles/common/parity/notes.json";

const WORK_PATH = "<WORK_PATH>";

/** The stored value, and the same value as a JSON layer holds it. */
const BACKSLASH_VALUE = String.raw`C:\Users\jdoe`;

const BACKSLASH_JSON = String.raw`{"path":"C:\\Users\\jdoe"}`;

const OLD_BACKSLASH_JSON = String.raw`{"path":"C:\\Users\\user"}`;

const QUOTE_VALUE = 'say "hi"';

const QUOTE_JSON = String.raw`{"note":"say \"hi\""}`;

const OLD_QUOTE_JSON = '{"note":"old"}';

/** An email whose `@` the JSON text writes as a `\uXXXX` escape. */
const UNICODE_EMAIL_JSON = String.raw`{"email":"jane\u0040work1.example.com"}`;

const WHOLE_TEXT = "email=jane@work1.example.com\n";

function configOf(entry: ConfigV2Entry): ConfigV2 {
  return {
    schemaVersion: 2,
    modules: { parity: { description: "Parity case files" } },
    entries: [entry],
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function profileOf(values: Readonly<Record<string, string>>): Profile {
  return {
    name: PROFILE_NAME,
    modules: ["parity"],
    values,
    destinations: {},
    retired: false,
  };
}

function snapshotOf(
  repo: Readonly<Record<string, string>>,
  entry: ConfigV2Entry = JSON_ENTRY,
): Snapshot {
  const repoFiles = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(repo)) {
    repoFiles.set(path, bytes(text));
  }
  return {
    config: configOf(entry),
    os: "linux",
    profile: profileOf({ [PLACEHOLDER]: PROFILE_VALUE }),
    home: HOME,
    cwd: HOME,
    repoFiles,
    localFiles: new Map(),
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
  };
}

function planOf(action: Action): RunPlan {
  return {
    steps: [
      {
        label: "step",
        line: 0,
        counted: true,
        actions: [{ action, failure: "failed" }],
      },
    ],
    finish: [],
    lines: [],
    summary: { kind: "none" },
    code: 0,
  };
}

function writeRepo(path: string, text: string): Action {
  return { kind: "writeRepo", path, bytes: bytes(text) };
}

/** The hits for one write to `path`, its change lines from `changeLines`. */
function hitsFor(
  repo: Readonly<Record<string, string>>,
  path: string,
  text: string,
  values: Readonly<Record<string, string>> = { [PLACEHOLDER]: PROFILE_VALUE },
  entry: ConfigV2Entry = JSON_ENTRY,
): ReturnType<typeof profileValueHits> {
  const plan = planOf(writeRepo(path, text));
  const snapshot = {
    ...snapshotOf(repo, entry),
    profile: profileOf(values),
  };
  return profileValueHits(plan, snapshot, changeLines(plan, snapshot));
}

describe("profileValueHits", () => {
  test("finds a profile value in a base write", () => {
    // Arrange / Act
    const hits = hitsFor({ [BASE_JSON]: OLD_JSON }, BASE_JSON, NEW_JSON);

    // Assert
    expect(hits).toEqual([
      {
        change: 1,
        module: "parity",
        file: "settings.json",
        placeholder: PLACEHOLDER,
        layer: "base",
      },
    ]);
  });

  test("finds an upper-case value in the file", () => {
    // Arrange / Act
    const hits = hitsFor({ [BASE_JSON]: OLD_JSON }, BASE_JSON, UPPER_JSON);

    // Assert
    expect(hits.map((hit) => hit.placeholder)).toEqual([PLACEHOLDER]);
  });

  test("ignores a profile-layer write", () => {
    // Arrange / Act
    const hits = hitsFor({ [PROFILE_JSON]: OLD_JSON }, PROFILE_JSON, NEW_JSON);

    // Assert
    expect(hits).toEqual([]);
  });

  test("skips an empty profile value", () => {
    // Arrange / Act
    const hits = hitsFor({ [BASE_JSON]: OLD_JSON }, BASE_JSON, NEW_JSON, {
      "<EMPTY>": "",
    });

    // Assert
    expect(hits).toEqual([]);
  });

  test("does not match the placeholder left in a sanitized file", () => {
    // Arrange / Act
    const hits = hitsFor({ [BASE_JSON]: OLD_JSON }, BASE_JSON, SANITIZED_JSON);

    // Assert
    expect(hits).toEqual([]);
  });

  test("finds an OS-layer hit", () => {
    // Arrange / Act
    const hits = hitsFor({ [OS_JSON]: OLD_JSON }, OS_JSON, NEW_JSON);

    // Assert
    expect(hits.map((hit) => hit.layer)).toEqual(["os"]);
  });
});

const TEAM_PLACEHOLDER = "<YOUR_TEAM>";
const TEAM_VALUE = "A4";
const TEAM_VALUES = { [TEAM_PLACEHOLDER]: TEAM_VALUE };
const TEAM_OLD_JSON = '{"color":"#000000","team":"none"}';
const TEAM_NEW_JSON = '{"color":"#90a4ae","team":"team A4 tools"}';

describe("holdsToken", () => {
  test.each<[string, string, boolean]>([
    ["#90a4ae", "inside a hex color", false],
    ["team a4 tools", "between spaces", true],
    ["team-a4", "after a -", true],
    ["a4_x", "before a _", true],
    ["a4 tools", "at the start of the text", true],
    ["team a4", "at the end of the text", true],
    ["a4", "as the whole text", true],
    ['"a4"', "between quotes", true],
    ["pa4ge", "inside a word", false],
    ["#a4b3c2 then a4", "once inside a token and once alone", true],
  ])("should read %p (%s) as %p", (text, _where, hit) => {
    expect(holdsToken(text, "a4")).toBe(hit);
  });

  test("should find no hit for an empty form", () => {
    expect(holdsToken("anything", "")).toBe(false);
  });
});

describe("profileValueHits as whole tokens", () => {
  test("should find no hit for a value inside a hex color", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: TEAM_OLD_JSON },
      BASE_JSON,
      '{"color":"#90a4ae","team":"none"}',
      TEAM_VALUES,
    );

    // Assert
    expect(hits).toEqual([]);
  });

  test("should number the hit by the change that holds the value as a token", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: TEAM_OLD_JSON },
      BASE_JSON,
      TEAM_NEW_JSON,
      TEAM_VALUES,
    );

    // Assert
    expect(hits.map((hit) => [hit.change, hit.placeholder])).toEqual([
      [2, TEAM_PLACEHOLDER],
    ]);
  });

  test("should find a value right after a \\n escape in JSON text", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: TEAM_OLD_JSON },
      BASE_JSON,
      String.raw`{"color":"#000000","team":"line\nA4"}`,
      TEAM_VALUES,
    );

    // Assert
    expect(hits.map((hit) => [hit.change, hit.placeholder])).toEqual([
      [1, TEAM_PLACEHOLDER],
    ]);
  });

  test("should number the hit by the change that brings the value, not one that removes it", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: '{"former":"A4","latter":"none"}' },
      BASE_JSON,
      '{"former":"none","latter":"A4"}',
      TEAM_VALUES,
    );

    // Assert
    expect(hits.map((hit) => hit.change)).toEqual([2]);
  });

  test("should number a backslash value by the change that holds it JSON-escaped", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: '{"a":"x","user":"none"}' },
      BASE_JSON,
      String.raw`{"a":"y","user":"CORP\\jdoe"}`,
      { "<WORK_USER>": String.raw`CORP\jdoe` },
    );

    // Assert
    expect(hits.map((hit) => hit.change)).toEqual([2]);
  });

  test.each<[string, string]>([
    ["A4\nmore\n", "at the start of the text"],
    ["more\nA4", "at the end of the text"],
  ])("should find a value %s in a whole file", (text, _where) => {
    // Arrange / Act
    const hits = hitsFor({}, WHOLE_PATH, text, TEAM_VALUES, WHOLE_ENTRY);

    // Assert
    expect(hits.map((hit) => hit.placeholder)).toEqual([TEAM_PLACEHOLDER]);
  });
});

describe("profileValueHits on escaped and unlabelled forms", () => {
  test("finds a raw value in a whole-file layer", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [WHOLE_PATH]: "email=old@example.com\n" },
      WHOLE_PATH,
      WHOLE_TEXT,
      { [PLACEHOLDER]: PROFILE_VALUE },
      WHOLE_ENTRY,
    );

    // Assert
    expect(hits).toEqual([
      {
        change: 1,
        module: "parity",
        file: "profile.sh",
        placeholder: PLACEHOLDER,
        layer: "base",
      },
    ]);
  });

  test("finds a backslash value stored JSON-escaped", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: OLD_BACKSLASH_JSON },
      BASE_JSON,
      BACKSLASH_JSON,
      { [WORK_PATH]: BACKSLASH_VALUE },
    );

    // Assert
    expect(hits).toEqual([
      {
        change: 1,
        module: "parity",
        file: "settings.json",
        placeholder: WORK_PATH,
        layer: "base",
      },
    ]);
  });

  test("finds a value with a quote stored escaped", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: OLD_QUOTE_JSON },
      BASE_JSON,
      QUOTE_JSON,
      { [PLACEHOLDER]: QUOTE_VALUE },
    );

    // Assert
    expect(hits.map((hit) => hit.placeholder)).toEqual([PLACEHOLDER]);
  });

  test("finds an email whose @ is a \\uXXXX escape in JSON text", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [BASE_JSON]: OLD_JSON },
      BASE_JSON,
      UNICODE_EMAIL_JSON,
    );

    // Assert
    expect(hits.map((hit) => hit.placeholder)).toEqual([PLACEHOLDER]);
  });

  test("records an import entry with no importName under its repo path", () => {
    // Arrange / Act
    const hits = hitsFor(
      { [IMPORT_PATH]: OLD_JSON },
      IMPORT_PATH,
      NEW_JSON,
      { [PLACEHOLDER]: PROFILE_VALUE },
      IMPORT_ENTRY,
    );

    // Assert
    expect(hits).toEqual([
      {
        change: 0,
        module: "parity",
        file: IMPORT_PATH,
        placeholder: PLACEHOLDER,
        layer: "base",
      },
    ]);
  });

  test("refuses when selectEntries fails", () => {
    // Arrange
    const plan = planOf(writeRepo(BASE_JSON, NEW_JSON));
    const snapshot = {
      ...snapshotOf({ [BASE_JSON]: OLD_JSON }),
      profile: profileOf({ [PLACEHOLDER]: PROFILE_VALUE }),
    };
    const failedSelect = (): {
      ok: false;
      error: { message: string; code: 1 };
    } => ({ ok: false, error: { message: "bad config", code: 1 } });

    // Act
    const run = (): unknown =>
      profileValueHits(plan, snapshot, [], failedSelect);

    // Assert
    expect(run).toThrow("entries can't be selected: bad config");
  });
});

describe("refusedLines", () => {
  test("prints the contract's two lines for a base hit", () => {
    // Arrange
    const hits = hitsFor({ [BASE_JSON]: OLD_JSON }, BASE_JSON, NEW_JSON);

    // Act
    const lines = refusedLines(hits, PROFILE_NAME, "linux");

    // Assert
    expect(lines).toEqual([
      "refused: change 1 (parity settings.json) holds a value of profile work-1 (<YOUR_EMAIL>) and would reach all machines.",
      'Move it to "profile work-1", or put <YOUR_EMAIL> in the file instead.',
    ]);
  });

  test("names the OS group in lower case for an OS hit", () => {
    // Arrange
    const hits = hitsFor({ [OS_JSON]: OLD_JSON }, OS_JSON, NEW_JSON);

    // Act
    const lines = refusedLines(hits, PROFILE_NAME, "linux");

    // Assert
    expect(lines[0]).toBe(
      "refused: change 1 (parity settings.json) holds a value of profile work-1 (<YOUR_EMAIL>) and would reach linux machines.",
    );
  });
});

const SAVING_RECORD: MachineRecord = {
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

describe("profileValueHits with the values the run saves", () => {
  test("should find a value only the run's profile write holds", () => {
    // Arrange
    const plan: RunPlan = {
      ...planOf(writeRepo(BASE_JSON, NEW_JSON)),
      prepare: [
        {
          kind: "writeMachineValues",
          record: SAVING_RECORD,
          profile: profileOf({ [PLACEHOLDER]: PROFILE_VALUE }),
        },
      ],
    };
    const snapshot = {
      ...snapshotOf({ [BASE_JSON]: OLD_JSON }),
      profile: profileOf({}),
    };

    // Act
    const hits = profileValueHits(plan, snapshot, changeLines(plan, snapshot));

    // Assert
    expect(hits.map((hit) => hit.placeholder)).toEqual([PLACEHOLDER]);
  });

  test("should find nothing when neither the profile nor the run holds the value", () => {
    // Arrange
    const plan = planOf(writeRepo(BASE_JSON, NEW_JSON));
    const snapshot = {
      ...snapshotOf({ [BASE_JSON]: OLD_JSON }),
      profile: profileOf({}),
    };

    // Act
    const hits = profileValueHits(plan, snapshot, changeLines(plan, snapshot));

    // Assert
    expect(hits).toEqual([]);
  });
});
