import { describe, expect, test } from "bun:test";
import type { SanitizeRule } from "../config/types.ts";
import { missingPlaceholders, resolveValues } from "./hydrate.ts";

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
    expect(resolved).toEqual({ ok: true, value: { "<YOUR_NAME>": "Jane Doe" } });
  });

  test("should skip a placeholder its defaultEnv fills", () => {
    // Arrange
    const rule: SanitizeRule = { ...NAME_RULE, defaultEnv: "PARITY_NAME" };

    // Act
    const missing = missingPlaceholders([rule], {}, {}, {
      PARITY_NAME: "Jane Doe",
    });

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
