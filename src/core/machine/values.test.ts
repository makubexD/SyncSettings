import { describe, expect, test } from "bun:test";
import type { Values } from "../values/sanitize.ts";
import type { ValuePlace } from "./values.ts";
import { moveUserValues, placeValue, VALUE_PLACES } from "./values.ts";

// The design's "Values" table and the contract's "Values on a machine".
const TABLE: (readonly [string, ValuePlace])[] = [
  ["<YOUR_NAME>", "profile"],
  ["<YOUR_EMAIL>", "profile"],
  ["<YOUR_GH_USERNAME>", "profile"],
  ["<YOUR_GH_ORG>", "profile"],
  ["<YOUR_WORK_MARKETPLACE>", "profile"],
  ["<HOME>", "machine"],
  ["<GH_CLI_PATH>", "machine"],
];

const MIXED: Values = {
  "<HOME>": "/home/user",
  "<YOUR_NAME>": "Jane Doe",
  "<OTHER>": "other value",
  "<GH_CLI_PATH>": "/usr/bin/gh",
  "<YOUR_EMAIL>": "jane@example.com",
  "<YOUR_GH_USERNAME>": "jane",
  "<YOUR_GH_ORG>": "acme",
  "<YOUR_WORK_MARKETPLACE>": "https://marketplace.example.com/work-1",
};

describe("placeValue", () => {
  test.each(TABLE)("keeps %s on the %s", (placeholder, place) => {
    // Act
    const result = placeValue(placeholder);

    // Assert
    expect(result).toBe(place);
  });

  test("names exactly the table's placeholders", () => {
    // Act
    const placeholders = Object.keys(VALUE_PLACES);

    // Assert
    expect(placeholders).toEqual(TABLE.map(([placeholder]) => placeholder));
  });

  test("asks about a placeholder the table doesn't name", () => {
    // Act
    const result = placeValue("<OTHER>");

    // Assert
    expect(result).toBe("ask");
  });
});

describe("moveUserValues", () => {
  test("splits every table row and an answered placeholder both ways", () => {
    // Arrange
    const answers = { "<OTHER>": "machine" } as const;

    // Act
    const moved = moveUserValues(MIXED, answers);

    // Assert
    expect(Object.keys(moved.profile)).toEqual([
      "<YOUR_NAME>",
      "<YOUR_EMAIL>",
      "<YOUR_GH_USERNAME>",
      "<YOUR_GH_ORG>",
      "<YOUR_WORK_MARKETPLACE>",
    ]);
    expect(moved.profile).toEqual({
      "<YOUR_NAME>": "Jane Doe",
      "<YOUR_EMAIL>": "jane@example.com",
      "<YOUR_GH_USERNAME>": "jane",
      "<YOUR_GH_ORG>": "acme",
      "<YOUR_WORK_MARKETPLACE>": "https://marketplace.example.com/work-1",
    });
    expect(Object.keys(moved.machine)).toEqual([
      "<HOME>",
      "<OTHER>",
      "<GH_CLI_PATH>",
    ]);
    expect(moved.machine).toEqual({
      "<HOME>": "/home/user",
      "<OTHER>": "other value",
      "<GH_CLI_PATH>": "/usr/bin/gh",
    });
  });

  test("keeps an answered placeholder on the profile", () => {
    // Arrange
    const values: Values = { "<OTHER>": "other value" };
    const answers = { "<OTHER>": "profile" } as const;

    // Act
    const moved = moveUserValues(values, answers);

    // Assert
    expect(moved).toEqual({
      profile: { "<OTHER>": "other value" },
      machine: {},
    });
  });

  test("keeps an unanswered placeholder on the profile", () => {
    // Arrange
    const values: Values = { "<OTHER>": "other value" };

    // Act
    const moved = moveUserValues(values, {});

    // Assert
    expect(moved).toEqual({
      profile: { "<OTHER>": "other value" },
      machine: {},
    });
  });

  test("gives two empty objects for an empty file", () => {
    // Act
    const moved = moveUserValues({}, {});

    // Assert
    expect(moved).toEqual({ profile: {}, machine: {} });
  });
});
