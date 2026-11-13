import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { changeLines } from "./changes.ts";
import { profileValueHits, refusedLines } from "./profilevalues.ts";
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

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { parity: { description: "Parity case files" } },
  entries: [JSON_ENTRY],
};

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

function snapshotOf(repo: Readonly<Record<string, string>>): Snapshot {
  const repoFiles = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(repo)) {
    repoFiles.set(path, bytes(text));
  }
  return {
    config: CONFIG,
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
): ReturnType<typeof profileValueHits> {
  const plan = planOf(writeRepo(path, text));
  const snapshot = { ...snapshotOf(repo), profile: profileOf(values) };
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
    const hits = hitsFor(
      { [BASE_JSON]: OLD_JSON },
      BASE_JSON,
      SANITIZED_JSON,
    );

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

describe("refusedLines", () => {
  test("prints the contract's two lines for a base hit", () => {
    // Arrange
    const hits = hitsFor({ [BASE_JSON]: OLD_JSON }, BASE_JSON, NEW_JSON);

    // Act
    const lines = refusedLines(hits, PROFILE_NAME, "linux");

    // Assert
    expect(lines).toEqual([
      'refused: change 1 (parity settings.json) holds a value of profile work-1 (<YOUR_EMAIL>) and would reach all machines.',
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
      'refused: change 1 (parity settings.json) holds a value of profile work-1 (<YOUR_EMAIL>) and would reach linux machines.',
    );
  });
});
