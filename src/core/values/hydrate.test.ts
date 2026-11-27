import { describe, expect, test } from "bun:test";
import type { SanitizeRule } from "../config/types.ts";
import {
  foundGhPathValues,
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

const GH_PLACEHOLDER = "<GH_CLI_PATH>";

const GH_DEFAULT = "C:\\Program Files\\GitHub CLI\\gh.exe";

const FOUND_GH = "C:\\Users\\user\\scoop\\shims\\gh.exe";

const SAVED_GH = "D:\\tools\\gh.exe";

const GH_RULE: SanitizeRule = {
  placeholder: GH_PLACEHOLDER,
  prompt: "Path to GitHub CLI executable",
  default: GH_DEFAULT,
  suggest: ["gh-path"],
  escapeBackslashes: true,
};

describe("foundGhPathValues", () => {
  test("should make the found gh path the value, ahead of the default", () => {
    // Arrange
    const inferred = foundGhPathValues([GH_RULE], FOUND_GH);

    // Act
    const resolved = resolveValues([GH_RULE], {}, inferred, {});

    // Assert
    expect(inferred).toEqual({ [GH_PLACEHOLDER]: FOUND_GH });
    expect(resolved).toEqual({
      ok: true,
      value: { [GH_PLACEHOLDER]: FOUND_GH },
    });
  });

  test("should take the default and save nothing when gh isn't found", () => {
    // Arrange
    const inferred = foundGhPathValues([GH_RULE], undefined);

    // Act
    const resolved = resolveValues([GH_RULE], {}, inferred, {});

    // Assert
    expect(inferred).toEqual({});
    expect(resolved).toEqual({
      ok: true,
      value: { [GH_PLACEHOLDER]: GH_DEFAULT },
    });
  });

  test("should leave a saved value ahead of the found path and the default", () => {
    // Arrange
    const inferred = foundGhPathValues([GH_RULE], FOUND_GH);

    // Act
    const resolved = resolveValues(
      [GH_RULE],
      { [GH_PLACEHOLDER]: SAVED_GH },
      inferred,
      {},
    );

    // Assert
    expect(resolved).toEqual({
      ok: true,
      value: { [GH_PLACEHOLDER]: SAVED_GH },
    });
  });

  test.each<[string, SanitizeRule]>([
    [
      "no default",
      { placeholder: GH_PLACEHOLDER, prompt: "gh", suggest: ["gh-path"] },
    ],
    ["no gh-path source", { ...GH_RULE, suggest: ["gh-login"] }],
  ])("should not give the found path to a rule with %s", (_label, rule) => {
    expect(foundGhPathValues([rule], FOUND_GH)).toEqual({});
  });

  test("should not give a found path that holds placeholder text", () => {
    expect(foundGhPathValues([GH_RULE], "/opt/<GH_CLI_PATH>/gh")).toEqual({});
  });
});
