import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, Os } from "../config/types.ts";
import type { MachineRecord } from "./record.ts";
import { machineScope, machineValues } from "./scope.ts";

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {
    git: { description: "Git settings" },
    shell: { description: "Shell settings" },
    gnome: { description: "GNOME desktop", os: ["linux"] },
    vscode: { description: "VS Code settings", os: ["linux", "macos"] },
    claude: { description: "Claude config" },
    "claude-worker": { description: "Claude worker config" },
    other: { description: "Other settings" },
  },
  entries: [],
};

const PROFILE: Profile = {
  name: "work-1",
  modules: ["git", "shell"],
  values: {},
  destinations: {},
  retired: false,
};

const RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
  claude: "claude-deepseek",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

function profileWith(modules: readonly string[]): Profile {
  return { ...PROFILE, modules };
}

function recordWith(overrides: Partial<MachineRecord>): MachineRecord {
  return { ...RECORD, ...overrides };
}

function scopeOn(
  modules: readonly string[],
  record: MachineRecord | undefined,
  os: Os = "linux",
) {
  return machineScope(CONFIG, profileWith(modules), record, os);
}

describe("machineScope", () => {
  test("takes the profile's modules when the record adds nothing", () => {
    // Act
    const scope = scopeOn(["git", "shell"], RECORD);

    // Assert
    expect(scope).toEqual({ on: ["git", "shell"], off: [] });
  });

  test("appends the record's add after the profile's modules", () => {
    // Arrange
    const record = recordWith({ modules: { add: ["other"], remove: [] } });

    // Act
    const scope = scopeOn(["git"], record);

    // Assert
    expect(scope).toEqual({ on: ["git", "other"], off: [] });
  });

  test("lists a module the profile and add both name once", () => {
    // Arrange
    const record = recordWith({
      modules: { add: ["git", "other"], remove: [] },
    });

    // Act
    const scope = scopeOn(["git"], record);

    // Assert
    expect(scope).toEqual({ on: ["git", "other"], off: [] });
  });

  test("turns off a module the record removes", () => {
    // Arrange
    const record = recordWith({ modules: { add: [], remove: ["shell"] } });

    // Act
    const scope = scopeOn(["git", "shell"], record);

    // Assert
    expect(scope).toEqual({
      on: ["git"],
      off: [{ module: "shell", reason: "shell off on this machine" }],
    });
  });

  test("turns off both Claude modules when the mode is none", () => {
    // Arrange
    const record = recordWith({ claude: "none" });

    // Act
    const scope = scopeOn(["claude", "claude-worker"], record);

    // Assert
    expect(scope).toEqual({
      on: [],
      off: [
        { module: "claude", reason: "claude off by the Claude mode" },
        {
          module: "claude-worker",
          reason: "claude-worker off by the Claude mode",
        },
      ],
    });
  });

  test("turns off only the worker when the mode is claude", () => {
    // Arrange
    const record = recordWith({ claude: "claude" });

    // Act
    const scope = scopeOn(["claude", "claude-worker"], record);

    // Assert
    expect(scope).toEqual({
      on: ["claude"],
      off: [
        {
          module: "claude-worker",
          reason: "claude-worker off by the Claude mode",
        },
      ],
    });
  });

  test("turns nothing off when the mode is claude-deepseek", () => {
    // Arrange
    const record = recordWith({ claude: "claude-deepseek" });

    // Act
    const scope = scopeOn(["claude", "claude-worker"], record);

    // Assert
    expect(scope).toEqual({ on: ["claude", "claude-worker"], off: [] });
  });

  test("turns off a profile module limited to another OS", () => {
    // Act
    const scope = scopeOn(["vscode"], RECORD, "windows");

    // Assert
    expect(scope).toEqual({
      on: [],
      off: [{ module: "vscode", reason: "vscode off, linux or macos only" }],
    });
  });

  test("turns off an added module limited to another OS", () => {
    // Arrange
    const record = recordWith({ modules: { add: ["gnome"], remove: [] } });

    // Act
    const scope = scopeOn([], record, "windows");

    // Assert
    expect(scope).toEqual({
      on: [],
      off: [{ module: "gnome", reason: "gnome off, linux only" }],
    });
  });

  test("gives the remove reason when the OS also excludes the module", () => {
    // Arrange
    const record = recordWith({ modules: { add: [], remove: ["vscode"] } });

    // Act
    const scope = scopeOn(["vscode"], record, "windows");

    // Assert
    expect(scope).toEqual({
      on: [],
      off: [{ module: "vscode", reason: "vscode off on this machine" }],
    });
  });

  test("takes every config module in config order with no profile or record", () => {
    // Act
    const scope = machineScope(CONFIG, undefined, undefined, "windows");

    // Assert
    expect(scope).toEqual({
      on: ["git", "shell", "claude", "claude-worker", "other"],
      off: [
        { module: "gnome", reason: "gnome off, linux only" },
        { module: "vscode", reason: "vscode off, linux or macos only" },
      ],
    });
  });
});

describe("machineValues", () => {
  test("lets the record's value win", () => {
    // Arrange
    const profile: Profile = {
      ...PROFILE,
      values: { "<HOME>": "/home/user", "<YOUR_NAME>": "jane" },
    };
    const record = recordWith({ values: { "<HOME>": "C:\\Users\\user" } });

    // Act
    const values = machineValues(profile, record);

    // Assert
    expect(values).toEqual({
      "<HOME>": "C:\\Users\\user",
      "<YOUR_NAME>": "jane",
    });
  });

  test("takes the profile's values when the record has none", () => {
    // Arrange
    const profile: Profile = { ...PROFILE, values: { "<YOUR_NAME>": "jane" } };

    // Act
    const values = machineValues(profile, RECORD);

    // Assert
    expect(values).toEqual({ "<YOUR_NAME>": "jane" });
  });

  test("takes the record's values when the profile has none", () => {
    // Arrange
    const record = recordWith({ values: { "<HOME>": "/home/user" } });

    // Act
    const values = machineValues(PROFILE, record);

    // Assert
    expect(values).toEqual({ "<HOME>": "/home/user" });
  });

  test("gives an empty object with no profile or record", () => {
    // Act
    const values = machineValues(undefined, undefined);

    // Assert
    expect(values).toEqual({});
  });
});
