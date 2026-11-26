import { describe, expect, test } from "bun:test";
import type { SanitizeRule } from "../config/types.ts";
import {
  inferValuesUnique,
  missingPlaceholders,
  resolveValues,
} from "./hydrate.ts";

const NAME_RULE: SanitizeRule = {
  placeholder: "<YOUR_NAME>",
  prompt: "Full name",
};

describe("missingPlaceholders", () => {
  test("should return nothing when there are no rules", () => {
    // Act
    const missing = missingPlaceholders([], {}, {}, {});

    // Assert
    expect(missing).toEqual([]);
  });

  test("should skip a placeholder that has a cached value", () => {
    // Act
    const missing = missingPlaceholders(
      [NAME_RULE],
      { "<YOUR_NAME>": "Jane Doe" },
      {},
      {},
    );

    // Assert
    expect(missing).toEqual([]);
  });

  test("should skip a placeholder that has an inferred value", () => {
    // Act
    const missing = missingPlaceholders(
      [NAME_RULE],
      {},
      { "<YOUR_NAME>": "Jane Doe" },
      {},
    );

    // Assert
    expect(missing).toEqual([]);
  });

  test("should skip a placeholder the rule's default fills", () => {
    // Arrange
    const rule: SanitizeRule = { ...NAME_RULE, default: "Jane Doe" };

    // Act
    const missing = missingPlaceholders([rule], {}, {}, {});
    const resolved = resolveValues([rule], {}, {}, {});

    // Assert
    expect(missing).toEqual([]);
    expect(resolved).toEqual({
      ok: true,
      value: { "<YOUR_NAME>": "Jane Doe" },
    });
  });

  test("should skip a placeholder its defaultEnv fills", () => {
    // Arrange
    const rule: SanitizeRule = { ...NAME_RULE, defaultEnv: "PARITY_NAME" };

    // Act
    const missing = missingPlaceholders(
      [rule],
      {},
      {},
      {
        PARITY_NAME: "Jane Doe",
      },
    );

    // Assert
    expect(missing).toEqual([]);
  });

  test("should return the first rule of a placeholder nothing fills", () => {
    // Arrange
    const second: SanitizeRule = { ...NAME_RULE, prompt: "Name again" };

    // Act
    const missing = missingPlaceholders([NAME_RULE, second], {}, {}, {});

    // Assert
    expect(missing).toEqual([NAME_RULE]);
  });
});

const UNIQUE_RULE = NAME_RULE;

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("inferValuesUnique", () => {
  test("should read a value from a shifted line when only one local line fits", () => {
    // Arrange
    const repo = textBytes("name = <YOUR_NAME>\ncolor = red\n");
    const local = textBytes("# added\ncolor = blue\nname = Ana Lopez\n");

    // Act
    const inferred = inferValuesUnique(local, repo, [UNIQUE_RULE]);

    // Assert
    expect(Object.fromEntries(inferred)).toEqual({
      "<YOUR_NAME>": "Ana Lopez",
    });
  });

  test("should mark a placeholder ambiguous when two local lines fit", () => {
    // Arrange
    const repo = textBytes('    "<YOUR_NAME>"\n');
    const local = textBytes('    "other"\n    "Ana Lopez"\n');

    // Act
    const inferred = inferValuesUnique(local, repo, [UNIQUE_RULE]);

    // Assert
    expect(inferred.get("<YOUR_NAME>")).toBeNull();
  });

  test("should mark a placeholder ambiguous when two repo lines give different values", () => {
    // Arrange
    const repo = textBytes("name = <YOUR_NAME>\nauthor: <YOUR_NAME>\n");
    const local = textBytes("name = Ana Lopez\nauthor: Old Name\n");

    // Act
    const inferred = inferValuesUnique(local, repo, [UNIQUE_RULE]);

    // Assert
    expect(inferred.get("<YOUR_NAME>")).toBeNull();
  });

  test("should infer nothing when no local line fits", () => {
    // Arrange
    const repo = textBytes("name = <YOUR_NAME>\n");
    const local = textBytes("color = blue\n");

    // Act
    const inferred = inferValuesUnique(local, repo, [UNIQUE_RULE]);

    // Assert
    expect(inferred.size).toBe(0);
  });
});
