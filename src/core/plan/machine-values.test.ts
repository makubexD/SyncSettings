import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { MachineRecord } from "../machine/record.ts";
import type { Values } from "../values/sanitize.ts";
import { machineValuesWrite } from "./machine-values.ts";
import type { Snapshot } from "./types.ts";

const RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
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

const PROFILE: Profile = {
  name: "work-1",
  modules: ["parity"],
  values: {},
  destinations: {},
  retired: false,
};

function recordWith(values: Values): MachineRecord {
  return { ...RECORD, values };
}

function profileWith(values: Values): Profile {
  return { ...PROFILE, values };
}

function snapshot(record: MachineRecord, profile: Profile): Snapshot {
  return {
    config: { schemaVersion: 2, modules: {}, entries: [] },
    os: "linux",
    profile,
    record,
    home: "/home/user",
    cwd: "/home/user",
    repoFiles: new Map(),
    localFiles: new Map(),
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
  };
}

describe("machineValuesWrite", () => {
  test("should write a changed record value to the machine entries", () => {
    // Arrange
    const record = recordWith({ "<HOME>": "/old" });
    const profile = profileWith({});

    // Act
    const actual = machineValuesWrite(snapshot(record, profile), {
      "<HOME>": "/new",
    });

    // Assert
    expect(actual).toEqual({
      kind: "writeMachineValues",
      record: recordWith({ "<HOME>": "/new" }),
      profile,
    });
  });

  test("should write a changed profile value to the profile entries", () => {
    // Arrange
    const record = recordWith({});
    const profile = profileWith({ "<YOUR_NAME>": "Old Name" });

    // Act
    const actual = machineValuesWrite(snapshot(record, profile), {
      "<YOUR_NAME>": "New Name",
    });

    // Assert
    expect(actual).toEqual({
      kind: "writeMachineValues",
      record,
      profile: profileWith({ "<YOUR_NAME>": "New Name" }),
    });
  });

  test("should skip unchanged record and profile values", () => {
    // Arrange
    const record = recordWith({ "<HOME>": "/same" });
    const profile = profileWith({ "<YOUR_NAME>": "Same Name" });

    // Act
    const actual = machineValuesWrite(snapshot(record, profile), {
      "<HOME>": "/same",
      "<YOUR_NAME>": "Same Name",
    });

    // Assert
    expect(actual).toBeUndefined();
  });

  test("should place a new machine value on the record", () => {
    // Arrange
    const record = recordWith({});
    const profile = profileWith({});

    // Act
    const actual = machineValuesWrite(snapshot(record, profile), {
      "<HOME>": "/new",
    });

    // Assert
    expect(actual).toEqual({
      kind: "writeMachineValues",
      record: recordWith({ "<HOME>": "/new" }),
      profile,
    });
  });

  test("should place a new profile value on the profile", () => {
    // Arrange
    const record = recordWith({});
    const profile = profileWith({});

    // Act
    const actual = machineValuesWrite(snapshot(record, profile), {
      "<YOUR_NAME>": "New Name",
    });

    // Assert
    expect(actual).toEqual({
      kind: "writeMachineValues",
      record,
      profile: profileWith({ "<YOUR_NAME>": "New Name" }),
    });
  });
});
