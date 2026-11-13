import { describe, expect, test } from "bun:test";
import { guard } from "./guard.ts";
import type { LocalRecords } from "./guard.ts";

const RECORD_NAME = "wk1-laptop";

const PROFILE_NAME = "work-1";

const OTHER_PROFILE_NAME = "personal";

const RECORD_PATH = "machines/wk1-laptop.json";

const PROFILE_PATH = "profiles/work-1.json";

const OTHER_PROFILE_PATH = "profiles/personal.json";

const NESTED_PROFILE_PATH = "profiles/work-1/vscode/settings.json";

const RECORD = { name: RECORD_NAME };

const PROFILES = [{ name: PROFILE_NAME }, { name: OTHER_PROFILE_NAME }];

const LOCAL_RECORDS: LocalRecords = { record: RECORD, profiles: PROFILES };

const NO_LOCAL_RECORDS: LocalRecords = { profiles: [] };

const TRACKED_PATHS: readonly string[] = [
  "dotfiles/common/git/.gitconfig",
  "sync-config.v2.json",
  PROFILE_PATH,
  RECORD_PATH,
  NESTED_PROFILE_PATH,
];

describe("guard", () => {
  test("should hold the record and every profile while public", () => {
    // Arrange

    // Act
    const decision = guard("public", [], LOCAL_RECORDS);

    // Assert
    expect(decision.held).toEqual([
      RECORD_PATH,
      OTHER_PROFILE_PATH,
      PROFILE_PATH,
    ]);
    expect(decision.refused).toEqual([]);
  });

  test("should refuse tracked repo paths under profiles and machines while public", () => {
    // Arrange

    // Act
    const decision = guard("public", TRACKED_PATHS, NO_LOCAL_RECORDS);

    // Assert
    expect(decision.refused).toEqual([
      RECORD_PATH,
      PROFILE_PATH,
      NESTED_PROFILE_PATH,
    ]);
  });

  test("should hold and refuse nothing when the repo is private", () => {
    // Arrange

    // Act
    const decision = guard("private", TRACKED_PATHS, LOCAL_RECORDS);

    // Assert
    expect(decision.held).toEqual([]);
    expect(decision.refused).toEqual([]);
  });

  test("should hold nothing when local state has no record or profile", () => {
    // Arrange

    // Act
    const decision = guard("public", [], NO_LOCAL_RECORDS);

    // Assert
    expect(decision.held).toEqual([]);
    expect(decision.refused).toEqual([]);
  });

  test("should hold the profiles but no record when local state has no record", () => {
    // Arrange
    const localRecords: LocalRecords = { profiles: PROFILES };

    // Act
    const decision = guard("public", [], localRecords);

    // Assert
    expect(decision.held).toEqual([OTHER_PROFILE_PATH, PROFILE_PATH]);
  });
});
