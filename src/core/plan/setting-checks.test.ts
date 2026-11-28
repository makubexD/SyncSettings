import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, Os } from "../config/types.ts";
import { settingMoveRefusals } from "./setting-checks.ts";
import type { RunPlan, Snapshot } from "./types.ts";

const PROFILE_NAME = "work1";
const LABEL = "vscode settings.json team";
const LINUX_HOME = "/home/user";
const WINDOWS_HOME = String.raw`C:\Users\jdoe`;

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { vscode: { description: "VS Code" } },
  entries: [
    {
      file: "vscode/settings.json",
      module: "vscode",
      merge: "json",
      localPath: "~/.config/Code/User/settings.json",
      description: "VS Code settings",
    },
  ],
};

function basePath(): string {
  return "dotfiles/common/vscode/settings.json";
}

function osPath(os: Os): string {
  return `dotfiles/${os}/vscode/settings.json`;
}

function profilePath(): string {
  return `profiles/${PROFILE_NAME}/vscode/settings.json`;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function profileOf(values: Readonly<Record<string, string>>): Profile {
  return {
    name: PROFILE_NAME,
    modules: ["vscode"],
    values,
    destinations: {},
    retired: false,
  };
}

function snapshotOf(os: Os, home: string): Snapshot {
  return {
    config: CONFIG,
    os,
    home,
    cwd: home,
    repoFiles: new Map(),
    localFiles: new Map(),
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
  };
}

function planOf(writes: Readonly<Record<string, string>>): RunPlan {
  return {
    steps: [
      {
        label: "move",
        line: 0,
        counted: true,
        actions: Object.entries(writes).map(([path, text]) => ({
          action: { kind: "writeRepo", path, bytes: bytes(text) },
          failure: "failed",
        })),
      },
    ],
    finish: [],
    lines: [],
    summary: { kind: "none" },
    code: 0,
  };
}

interface CheckCase {
  readonly writes: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
  readonly os?: Os;
  readonly home?: string;
}

function refusalsFor(check: CheckCase): readonly string[] {
  const os = check.os ?? "linux";
  const home = check.home ?? LINUX_HOME;
  return settingMoveRefusals(
    planOf(check.writes),
    snapshotOf(os, home),
    profileOf(check.values ?? {}),
    home,
    os,
    LABEL,
  );
}

const VALUE_LINES = [
  `refused: ${LABEL} holds a value of profile work1 (<WORK_TEAM>) and would reach all machines.`,
  `Leave it in "profile work1", or put <WORK_TEAM> in the file instead.`,
];

const WORK_X_VALUE = "/opt/work";

const HOME_LINE = `refused: ${LABEL} holds this machine's home folder.`;

describe("settingMoveRefusals: profile values", () => {
  test("a profile value as a whole token is refused", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"team": "A4"}\n' },
      values: { "<WORK_TEAM>": "A4" },
    });

    // Assert
    expect(lines).toEqual(VALUE_LINES);
  });

  test("a profile value inside a longer token is not", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"color": "#A4B3C2"}\n' },
      values: { "<WORK_TEAM>": "A4" },
    });

    // Assert
    expect(lines).toEqual([]);
  });

  test("an OS layer names its machines", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [osPath("linux")]: '{"team": "A4"}\n' },
      values: { "<WORK_TEAM>": "A4" },
    });

    // Assert
    expect(lines[0]).toEndWith("and would reach linux machines.");
  });
});

describe("settingMoveRefusals: profile placeholders", () => {
  test("a placeholder whose value lives in the profile is refused", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"path": "<WORK_X>"}\n' },
      values: { "<WORK_X>": WORK_X_VALUE },
    });

    // Assert
    expect(lines).toEqual([
      `refused: ${LABEL} holds <WORK_X>, a value of profile work1; machines outside it have no value for it.`,
    ]);
  });

  test("a placeholder the value table names is allowed", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"name": "<YOUR_NAME>"}\n' },
      values: { "<YOUR_NAME>": "Jane Doe" },
    });

    // Assert
    expect(lines).toEqual([]);
  });
});

describe("settingMoveRefusals: the home folder", () => {
  test("the home folder as is is refused", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"bin": "/home/user/bin"}\n' },
    });

    // Assert
    expect(lines).toEqual([HOME_LINE]);
  });

  test("the home folder with \\ doubled is refused", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: {
        [osPath("windows")]: String.raw`{"bin": "C:\\Users\\jdoe\\bin"}`,
      },
      os: "windows",
      home: WINDOWS_HOME,
    });

    // Assert
    expect(lines).toEqual([HOME_LINE]);
  });

  test("on windows the home folder with / is refused", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"bin": "C:/Users/jdoe/bin"}' },
      os: "windows",
      home: WINDOWS_HOME,
    });

    // Assert
    expect(lines).toEqual([HOME_LINE]);
  });

  test("on linux the home folder with / for \\ is not a form", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"bin": "C:/Users/jdoe/bin"}' },
      os: "linux",
      home: WINDOWS_HOME,
    });

    // Assert
    expect(lines).toEqual([]);
  });

  test.each<[Os, string]>([
    ["windows", String.raw`{"bin": "c:\\users\\JDOE\\bin"}`],
    ["macos", '{"bin": "/USERS/jdoe/bin"}'],
  ])("on %s case is ignored", (os, text) => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: text },
      os,
      home: os === "windows" ? WINDOWS_HOME : "/Users/jdoe",
    });

    // Assert
    expect(lines).toEqual([HOME_LINE]);
  });

  test("on linux case counts", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: { [basePath()]: '{"bin": "/HOME/USER/bin"}' },
    });

    // Assert
    expect(lines).toEqual([]);
  });
});

describe("settingMoveRefusals: scope and order", () => {
  test("a move to the profile runs no check", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: {
        [profilePath()]: '{"team": "A4", "x": "<WORK_X>", "bin": "/home/user"}',
      },
      values: { "<WORK_TEAM>": "A4", "<WORK_X>": WORK_X_VALUE },
    });

    // Assert
    expect(lines).toEqual([]);
  });

  test("lines follow the contract's order", () => {
    // Arrange / Act
    const lines = refusalsFor({
      writes: {
        [basePath()]:
          '{"bin": "/home/user/bin", "x": "<WORK_X>", "team": "A4"}',
      },
      values: { "<WORK_TEAM>": "A4", "<WORK_X>": WORK_X_VALUE },
    });

    // Assert
    expect(lines).toEqual([
      ...VALUE_LINES,
      `refused: ${LABEL} holds <WORK_X>, a value of profile work1; machines outside it have no value for it.`,
      HOME_LINE,
    ]);
  });
});
