import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import { mergeProfileCopies } from "./copies.ts";

const NAME = "work-1";

function makeCopy(overrides: Partial<Profile> = {}): Profile {
  return {
    name: NAME,
    modules: [],
    values: {},
    destinations: {},
    retired: false,
    ...overrides,
  };
}

describe("mergeProfileCopies", () => {
  test("merges two equal copies without questions", () => {
    // Arrange
    const copy = makeCopy({
      modules: ["git"],
      values: { "<HOME>": "/home/user" },
      destinations: { "<HOME>": "profile" },
    });

    // Act
    const result = mergeProfileCopies([
      makeCopy({
        modules: ["git"],
        values: { "<HOME>": "/home/user" },
        destinations: { "<HOME>": "profile" },
      }),
      copy,
    ]);

    // Assert
    expect(result).toEqual({ profile: copy, questions: [] });
  });

  test("joins modules in first-seen order without duplicates", () => {
    // Arrange
    const first = makeCopy({ modules: ["git", "shell"] });
    const second = makeCopy({ modules: ["shell", "claude"] });

    // Act
    const result = mergeProfileCopies([first, second]);

    // Assert
    expect(result.profile.modules).toEqual(["git", "shell", "claude"]);
  });

  test("keeps a value only one copy has", () => {
    // Arrange
    const first = makeCopy({ values: { "<HOME>": "/home/user" } });
    const second = makeCopy();

    // Act
    const result = mergeProfileCopies([first, second]);

    // Assert
    expect(result.profile.values).toEqual({ "<HOME>": "/home/user" });
    expect(result.questions).toEqual([]);
  });

  test("keeps a value the copies agree on", () => {
    // Arrange
    const first = makeCopy({ values: { "<HOME>": "/home/user" } });
    const second = makeCopy({ values: { "<HOME>": "/home/user" } });

    // Act
    const result = mergeProfileCopies([first, second]);

    // Assert
    expect(result.profile.values).toEqual({ "<HOME>": "/home/user" });
    expect(result.questions).toEqual([]);
  });

  test("asks about a value the copies disagree on and leaves it out", () => {
    // Arrange
    const first = makeCopy({
      values: { "<HOME>": "/home/one", "<USER>": "one" },
    });
    const second = makeCopy({
      values: { "<HOME>": "/home/two", "<USER>": "one" },
    });

    // Act
    const result = mergeProfileCopies([first, second]);

    // Assert
    expect(result.profile.values).toEqual({ "<USER>": "one" });
    expect(result.questions).toEqual([
      {
        kind: "value",
        key: "<HOME>",
        choices: ["/home/one", "/home/two"],
      },
    ]);
  });

  test("asks about a destination the copies disagree on and leaves it out", () => {
    // Arrange
    const first = makeCopy({ destinations: { "<HOME>": "profile" } });
    const second = makeCopy({ destinations: { "<HOME>": "machine" } });

    // Act
    const result = mergeProfileCopies([first, second]);

    // Assert
    expect(result.profile.destinations).toEqual({});
    expect(result.questions).toEqual([
      {
        kind: "destination",
        key: "<HOME>",
        choices: ["profile", "machine"],
      },
    ]);
  });

  test("is retired when any copy is retired", () => {
    // Arrange
    const first = makeCopy({ retired: true });
    const second = makeCopy();

    // Act
    const result = mergeProfileCopies([first, second]);

    // Assert
    expect(result.profile.retired).toBe(true);
  });

  test("lists the two distinct values of three copies, first seen first", () => {
    // Arrange
    const first = makeCopy({ values: { "<HOME>": "/home/one" } });
    const second = makeCopy({ values: { "<HOME>": "/home/two" } });
    const third = makeCopy({ values: { "<HOME>": "/home/one" } });

    // Act
    const result = mergeProfileCopies([first, second, third]);

    // Assert
    expect(result.profile.values).toEqual({});
    expect(result.questions).toEqual([
      {
        kind: "value",
        key: "<HOME>",
        choices: ["/home/one", "/home/two"],
      },
    ]);
  });

  test("doesn't mutate the copies", () => {
    // Arrange
    const first = makeCopy({
      modules: ["git"],
      values: { "<HOME>": "/home/one" },
      destinations: { "<HOME>": "profile" },
    });
    const second = makeCopy({
      modules: ["shell"],
      values: { "<HOME>": "/home/two" },
      destinations: { "<HOME>": "machine" },
    });
    const before = structuredClone([first, second]);

    // Act
    mergeProfileCopies([first, second]);

    // Assert
    expect([first, second]).toEqual(before);
  });
});
