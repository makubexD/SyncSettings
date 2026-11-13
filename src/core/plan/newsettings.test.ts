import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import {
  newSettingChoices,
  storeDestination,
  storedDestination,
} from "./newsettings.ts";

const WORK_RECORD = { profile: "work-1" };

const PERSONAL_RECORD = { profile: "personal" };

const PROFILE: Profile = {
  name: "work-1",
  modules: ["git"],
  values: {},
  destinations: { "settings.json: a": "os" },
  retired: false,
};

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

describe("storedDestination", () => {
  test("finds the layer a key path stores", () => {
    // Act
    const layer = storedDestination(PROFILE, "settings.json: a");

    // Assert
    expect(layer).toBe("os");
  });

  test("gives undefined for a key path that isn't stored", () => {
    // Act
    const layer = storedDestination(PROFILE, "settings.json: b");

    // Assert
    expect(layer).toBeUndefined();
  });

  test("gives undefined without a profile", () => {
    // Act
    const layer = storedDestination(undefined, "settings.json: a");

    // Assert
    expect(layer).toBeUndefined();
  });
});

describe("storeDestination", () => {
  test("stores an array item's path without mutating the input", () => {
    // Act
    const stored = storeDestination(
      PROFILE,
      "settings.json: b",
      "machine",
      "item",
    );

    // Assert
    expect(stored).not.toBe(PROFILE);
    expect(stored.destinations).toEqual({
      "settings.json: a": "os",
      "settings.json: b": "machine",
    });
    expect(stored.modules).toEqual(PROFILE.modules);
    expect(stored.values).toEqual(PROFILE.values);
    expect(stored.retired).toBe(PROFILE.retired);
    expect(PROFILE.destinations).toEqual({ "settings.json: a": "os" });
  });

  test("doesn't store a key's answer", () => {
    // Act
    const stored = storeDestination(
      PROFILE,
      "settings.json: b",
      "machine",
      "key",
    );

    // Assert
    expect(stored).toBe(PROFILE);
    expect(stored.destinations).toEqual({ "settings.json: a": "os" });
  });
});
