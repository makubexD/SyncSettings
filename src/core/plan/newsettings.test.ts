import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import {
  answersOf,
  destinationKey,
  newSettingChoices,
  settingGroups,
  storeDestination,
  storedDestination,
} from "./newsettings.ts";
import type { NewSettingChoice } from "./newsettings.ts";
import type { NewSettingLine } from "./types.ts";

const WORK_RECORD = { profile: "work-1" };

const PERSONAL_RECORD = { profile: "personal" };

const PROFILE: Profile = {
  name: "work-1",
  modules: ["git"],
  values: {},
  destinations: { "parity settings.json: a": "os" },
  retired: false,
};

function itemOf(file: string, path: string): NewSettingLine {
  return {
    module: "parity",
    file,
    path,
    kind: "item",
    what: `${path}: "item"`,
  };
}

describe("newSettingChoices", () => {
  test("suggests the profile for a work profile", () => {
    // Act
    const question = newSettingChoices(WORK_RECORD, "linux");

    // Assert
    expect(question?.suggestion).toEqual({
      number: 3,
      layer: "profile",
      words: "profile work-1",
    });
  });

  test("suggests all machines for the personal profile", () => {
    // Act
    const question = newSettingChoices(PERSONAL_RECORD, "linux");

    // Assert
    expect(question?.suggestion).toEqual({
      number: 1,
      layer: "base",
      words: "all machines",
    });
  });

  test.each([
    ["windows", "Windows machines"],
    ["macos", "macOS machines"],
  ] as const)("names the %s machines in choice 2", (os, words) => {
    // Act
    const question = newSettingChoices(WORK_RECORD, os);

    // Assert
    expect(question?.choices[1]).toEqual({
      number: 2,
      layer: "os",
      words,
    });
  });

  test("gives the four layers in order", () => {
    // Act
    const question = newSettingChoices(WORK_RECORD, "linux");

    // Assert
    expect(question?.choices.map((choice) => choice.layer)).toEqual([
      "base",
      "os",
      "profile",
      "machine",
    ]);
  });

  test("gives no question without a record", () => {
    // Act
    const question = newSettingChoices(undefined, "linux");

    // Assert
    expect(question).toBeUndefined();
  });
});

describe("destinationKey", () => {
  test("names the module, the file and the path", () => {
    // Act
    const key = destinationKey("parity", "settings.json", "delta[]");

    // Assert
    expect(key).toBe("parity settings.json: delta[]");
  });
});

describe("settingGroups", () => {
  test("groups two items of one path", () => {
    // Act
    const groups = settingGroups([
      itemOf("settings.json", "delta[]"),
      itemOf("settings.json", "delta[]"),
    ]);

    // Assert
    expect(groups).toEqual([[0, 1]]);
  });

  test("gives the same path in two files two groups", () => {
    // Act
    const groups = settingGroups([
      itemOf("settings.json", "delta[]"),
      itemOf("other.json", "delta[]"),
    ]);

    // Assert
    expect(groups).toEqual([[0], [1]]);
  });
});

const ALL_MACHINES: NewSettingChoice = {
  number: 1,
  layer: "base",
  words: "all machines",
};

const THIS_MACHINE: NewSettingChoice = {
  number: 4,
  layer: "machine",
  words: "this machine",
};

describe("answersOf", () => {
  test("gives two items of one path one answer", () => {
    // Arrange
    const settings = [
      itemOf("settings.json", "delta[]"),
      itemOf("settings.json", "delta[]"),
    ];

    // Act
    const answers = answersOf(settings, [THIS_MACHINE, THIS_MACHINE]);

    // Assert
    expect([...answers]).toEqual([
      ["parity settings.json: delta[]", "machine"],
    ]);
  });

  test("gives the same path in two files two answers and two keys", () => {
    // Arrange
    const settings = [
      itemOf("settings.json", "delta[]"),
      itemOf("other.json", "delta[]"),
    ];

    // Act
    const answers = answersOf(settings, [THIS_MACHINE, ALL_MACHINES]);

    // Assert
    expect([...answers]).toEqual([
      ["parity settings.json: delta[]", "machine"],
      ["parity other.json: delta[]", "base"],
    ]);
  });
});

describe("storedDestination", () => {
  test("finds the layer a destination key stores", () => {
    // Act
    const layer = storedDestination(PROFILE, "parity settings.json: a");

    // Assert
    expect(layer).toBe("os");
  });

  test("gives undefined for a destination key that isn't stored", () => {
    // Act
    const layer = storedDestination(PROFILE, "parity settings.json: b");

    // Assert
    expect(layer).toBeUndefined();
  });

  test("gives undefined without a profile", () => {
    // Act
    const layer = storedDestination(undefined, "parity settings.json: a");

    // Assert
    expect(layer).toBeUndefined();
  });
});

describe("storeDestination", () => {
  test("stores an array item's destination key without mutating the input", () => {
    // Act
    const stored = storeDestination(
      PROFILE,
      "parity settings.json: b",
      "machine",
      "item",
    );

    // Assert
    expect(stored).not.toBe(PROFILE);
    expect(stored.destinations).toEqual({
      "parity settings.json: a": "os",
      "parity settings.json: b": "machine",
    });
    expect(stored.modules).toEqual(PROFILE.modules);
    expect(stored.values).toEqual(PROFILE.values);
    expect(stored.retired).toBe(PROFILE.retired);
    expect(PROFILE.destinations).toEqual({ "parity settings.json: a": "os" });
  });

  test("stores the same path in two files as two keys", () => {
    // Arrange
    const first = storeDestination(
      PROFILE,
      "parity settings.json: delta[]",
      "machine",
      "item",
    );

    // Act
    const stored = storeDestination(
      first,
      "parity other.json: delta[]",
      "base",
      "item",
    );

    // Assert
    expect(stored.destinations).toEqual({
      "parity settings.json: a": "os",
      "parity settings.json: delta[]": "machine",
      "parity other.json: delta[]": "base",
    });
  });

  test("doesn't store a key's answer", () => {
    // Act
    const stored = storeDestination(
      PROFILE,
      "parity settings.json: b",
      "machine",
      "key",
    );

    // Assert
    expect(stored).toBe(PROFILE);
    expect(stored.destinations).toEqual({ "parity settings.json: a": "os" });
  });
});
