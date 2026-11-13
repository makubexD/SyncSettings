import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { MachineRecord } from "./record.ts";
import {
  isYes,
  machineRetireQuestion,
  NOTHING_RETIRED,
  profileRetireQuestion,
  retireMachine,
  retireProfile,
} from "./retire.ts";

const NAME = "wk1-laptop";

const PROFILE_NAME = "work-1";

const PROFILE_PATH = "state/profiles/work-1.json";

const RECORD: MachineRecord = {
  name: NAME,
  profile: PROFILE_NAME,
  os: "windows",
  hostname: NAME,
  domain: "corp.example.com",
  claude: "claude",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const PROFILE: Profile = {
  name: PROFILE_NAME,
  modules: ["git"],
  values: {},
  destinations: {},
  retired: false,
};

describe("retireMachine", () => {
  test("should refuse a name when there is no record", () => {
    // Act
    const result = retireMachine(undefined, NAME);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1,
      line: `ERROR: no machine ${NAME} here; records are shared once the repo is private.`,
    });
  });

  test("should refuse a name that isn't the record's", () => {
    // Act
    const result = retireMachine(RECORD, "wk1-other");

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1,
      line: `ERROR: no machine wk1-other here; records are shared once the repo is private.`,
    });
  });

  test("should mark the record retired", () => {
    // Act
    const result = retireMachine(RECORD, NAME);

    // Assert
    expect(result).toEqual({
      ok: true,
      code: 0,
      line: `Machine ${NAME} retired.`,
      value: { ...RECORD, retired: true },
    });
  });

  test("should leave an already retired record alone", () => {
    // Arrange
    const retired: MachineRecord = { ...RECORD, retired: true };

    // Act
    const result = retireMachine(retired, NAME);

    // Assert
    expect(result).toEqual({
      ok: true,
      code: 0,
      line: `Machine ${NAME} is already retired.`,
    });
    expect(Object.hasOwn(result, "value")).toBe(false);
  });

  test("should not mutate the input record", () => {
    // Arrange
    const before = structuredClone(RECORD);

    // Act
    retireMachine(RECORD, NAME);

    // Assert
    expect(RECORD).toEqual(before);
  });
});

describe("retireProfile", () => {
  test("should refuse a profile that isn't in the store", () => {
    // Act
    const result = retireProfile(undefined, PROFILE_NAME, [], PROFILE_PATH);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1,
      line: `ERROR: profile ${PROFILE_NAME} not found: ${PROFILE_PATH}`,
    });
  });

  test("should refuse a profile that a non-retired record uses", () => {
    // Act
    const result = retireProfile(PROFILE, PROFILE_NAME, [RECORD], PROFILE_PATH);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1,
      line: `ERROR: profile ${PROFILE_NAME} is used by machine ${NAME}; retire or move that machine first.`,
    });
  });

  test("should name the first non-retired record that uses the profile", () => {
    // Arrange
    const first: MachineRecord = { ...RECORD, name: "wk1-first" };
    const second: MachineRecord = { ...RECORD, name: "wk1-second" };

    // Act
    const result = retireProfile(
      PROFILE,
      PROFILE_NAME,
      [first, second],
      PROFILE_PATH,
    );

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1,
      line: `ERROR: profile ${PROFILE_NAME} is used by machine wk1-first; retire or move that machine first.`,
    });
  });

  test("should not count a retired record that uses the profile", () => {
    // Arrange
    const retired: MachineRecord = { ...RECORD, retired: true };

    // Act
    const result = retireProfile(
      PROFILE,
      PROFILE_NAME,
      [retired],
      PROFILE_PATH,
    );

    // Assert
    expect(result).toEqual({
      ok: true,
      code: 0,
      line: `Profile ${PROFILE_NAME} retired.`,
      value: { ...PROFILE, retired: true },
    });
  });

  test("should mark the profile retired", () => {
    // Act
    const result = retireProfile(PROFILE, PROFILE_NAME, [], PROFILE_PATH);

    // Assert
    expect(result).toEqual({
      ok: true,
      code: 0,
      line: `Profile ${PROFILE_NAME} retired.`,
      value: { ...PROFILE, retired: true },
    });
  });

  test("should leave an already retired profile alone", () => {
    // Arrange
    const retired: Profile = { ...PROFILE, retired: true };

    // Act
    const result = retireProfile(retired, PROFILE_NAME, [], PROFILE_PATH);

    // Assert
    expect(result).toEqual({
      ok: true,
      code: 0,
      line: `Profile ${PROFILE_NAME} is already retired.`,
    });
    expect(Object.hasOwn(result, "value")).toBe(false);
  });

  test("should not mutate the input profile", () => {
    // Arrange
    const before = structuredClone(PROFILE);

    // Act
    retireProfile(PROFILE, PROFILE_NAME, [], PROFILE_PATH);

    // Assert
    expect(PROFILE).toEqual(before);
  });
});

describe("isYes", () => {
  test("should accept y and yes in any case", () => {
    for (const answer of ["y", "Y", "yes", "YES", "Yes"]) {
      expect(isYes(answer)).toBe(true);
    }
  });

  test("should accept either around spaces", () => {
    expect(isYes(" y ")).toBe(true);
    expect(isYes("\tyes\n")).toBe(true);
  });

  test("should refuse no answer at end of input", () => {
    expect(isYes(undefined)).toBe(false);
  });

  test("should refuse an empty answer or anything else", () => {
    for (const answer of ["", " ", "n", "no", "yep", "2"]) {
      expect(isYes(answer)).toBe(false);
    }
  });
});

describe("retire questions", () => {
  test("should print the machine question with one trailing space", () => {
    expect(machineRetireQuestion(NAME)).toBe(
      `Retire machine ${NAME}? It can't push after this. [y/N] `,
    );
  });

  test("should print the profile question with one trailing space", () => {
    expect(profileRetireQuestion(PROFILE_NAME)).toBe(
      `Retire profile ${PROFILE_NAME}? A first run won't offer it after this. [y/N] `,
    );
  });

  test("should print the declined answer", () => {
    expect(NOTHING_RETIRED).toBe("Nothing retired.");
  });
});
