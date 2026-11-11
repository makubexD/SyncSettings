import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SanitizeRule } from "../config/types.ts";
import { hydrate, inferValues, resolveValues } from "./hydrate.ts";
import { encodeUtf8, sanitize } from "./sanitize.ts";
import type { Values } from "./sanitize.ts";

const CASE_ROOT = new URL("../../../tests/parity/cases/", import.meta.url);

interface CaseEntry {
  readonly sanitizeRules?: readonly SanitizeRule[];
}

interface ParityCase {
  readonly config: { readonly files: readonly CaseEntry[] };
  readonly values?: Values;
}

function parityCase(name: string): ParityCase {
  return JSON.parse(
    readFileSync(new URL(`${name}/case.json`, CASE_ROOT), "utf8"),
  ) as ParityCase;
}

function caseRules(name: string): readonly SanitizeRule[] {
  return parityCase(name).config.files[0]?.sanitizeRules ?? [];
}

function caseValues(name: string): Values {
  return parityCase(name).values ?? {};
}

function caseBytes(name: string, relative: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`${name}/${relative}`, CASE_ROOT)));
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

function expectHydrated(
  result: ReturnType<typeof hydrate>,
  expected: Uint8Array,
): void {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expectBytes(result.value, expected);
  }
}

describe("sanitize", () => {
  test("sanitize-longest-first", () => {
    // Arrange
    const rules = caseRules("sanitize-longest-first");
    const values = caseValues("sanitize-longest-first");
    const local = caseBytes(
      "sanitize-longest-first",
      "home/.config/parity/a.conf",
    );
    const expected = caseBytes(
      "sanitize-longest-first",
      "expect/repo/dotfiles/common/parity/a.conf",
    );

    // Act
    const actual = sanitize(local, rules, values, { json: false });

    // Assert
    expectBytes(actual, expected);
  });

  test("sanitize-round-trip", () => {
    // Arrange
    const rules = caseRules("sanitize-round-trip");
    const values = caseValues("sanitize-round-trip");
    const local = caseBytes(
      "sanitize-round-trip",
      "home/.config/parity/git.conf",
    );
    const expectedRepo = caseBytes(
      "sanitize-round-trip",
      "expect/repo/dotfiles/common/parity/git.conf",
    );
    const expectedHome = caseBytes(
      "sanitize-round-trip",
      "expect/home/.config/parity/git.conf",
    );

    // Act
    const sanitized = sanitize(local, rules, values, { json: false });
    const hydrated = hydrate(sanitized, rules, values, { json: false });

    // Assert
    expectBytes(sanitized, expectedRepo);
    expectHydrated(hydrated, expectedHome);
  });

  test("a JSON value with quotes and backslashes round-trips", () => {
    // Arrange
    const rules: readonly SanitizeRule[] = [
      { placeholder: "<V>", prompt: "Value", escapeBackslashes: true },
    ];
    const values: Values = { "<V>": 'C:\\Users\\jane "JJ"' };
    const content = encodeUtf8('{"v": "<V>"}\n');

    // Act
    const hydrated = hydrate(content, rules, values, { json: true });
    const sanitized = sanitize(
      hydrated.ok ? hydrated.value : new Uint8Array(),
      rules,
      values,
      { json: true },
    );

    // Assert
    expect(hydrated.ok).toBe(true);
    if (hydrated.ok) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(hydrated.value));
      expect(parsed).toEqual({ v: 'C:\\Users\\jane "JJ"' });
      expectBytes(sanitized, content);
    }
  });
});

describe("hydrate", () => {
  test("hydrate-creates", () => {
    // Arrange
    const rules = caseRules("hydrate-creates");
    const values = caseValues("hydrate-creates");
    const repo = caseBytes(
      "hydrate-creates",
      "repo/dotfiles/common/parity/git.conf",
    );
    const expected = caseBytes(
      "hydrate-creates",
      "expect/home/.config/parity/git.conf",
    );

    // Act
    const actual = hydrate(repo, rules, values, { json: false });

    // Assert
    expectHydrated(actual, expected);
  });

  test("hydrate-escape-backslashes", () => {
    // Arrange
    const rules = caseRules("hydrate-escape-backslashes");
    const values = caseValues("hydrate-escape-backslashes");
    const repo = caseBytes(
      "hydrate-escape-backslashes",
      "repo/dotfiles/common/parity/a.conf",
    );
    const expected = caseBytes(
      "hydrate-escape-backslashes",
      "expect/home/.config/parity/a.conf",
    );

    // Act
    const actual = hydrate(repo, rules, values, { json: false });

    // Assert
    expect(actual.ok).toBe(true);
    if (actual.ok) {
      expectBytes(actual.value, expected);
    }
  });

  test("missing-value-stops", () => {
    // Arrange
    const rules = caseRules("missing-value-stops");
    const repo = caseBytes(
      "missing-value-stops",
      "repo/dotfiles/common/parity/a.conf",
    );

    // Act
    const actual = hydrate(repo, rules, {}, { json: false });

    // Assert
    expect(actual).toEqual({
      ok: false,
      error: {
        message:
          "missing value for <YOUR_NAME>: add it to .user-values.json",
        code: 1,
      },
    });
  });

  test("bytes 0xff 0xfe around a placeholder survive sanitize then hydrate", () => {
    // Arrange
    const rules: readonly SanitizeRule[] = [
      { placeholder: "<V>", prompt: "Value" },
    ];
    const values: Values = { "<V>": "C:\\Tools" };
    const content = Uint8Array.from([
      0xff,
      0xfe,
      ...encodeUtf8("<V>"),
      0xfe,
      0xff,
    ]);
    const expectedHydrated = Uint8Array.from([
      0xff,
      0xfe,
      ...encodeUtf8("C:\\Tools"),
      0xfe,
      0xff,
    ]);

    // Act
    const hydrated = hydrate(content, rules, values, { json: false });
    const sanitized = sanitize(
      hydrated.ok ? hydrated.value : new Uint8Array(),
      rules,
      values,
      { json: false },
    );

    // Assert
    expectHydrated(hydrated, expectedHydrated);
    expectBytes(sanitized, content);
  });
});

describe("inferValues", () => {
  test("infer-value", () => {
    // Arrange
    const rules = caseRules("infer-value");
    const local = caseBytes(
      "infer-value",
      "home/.config/parity/a.conf",
    );
    const repo = caseBytes(
      "infer-value",
      "repo/dotfiles/common/parity/a.conf",
    );
    const expected = JSON.parse(
      new TextDecoder().decode(caseBytes("infer-value", "expect/values.json")),
    ) as Values;

    // Act
    const inferred = inferValues(local, repo, rules);
    const hydrated = hydrate(repo, rules, inferred, { json: false });

    // Assert
    expect(inferred).toEqual(expected);
    expectHydrated(hydrated, local);
  });
});

describe("resolveValues", () => {
  test("missing-value-stops", () => {
    // Arrange
    const rules = caseRules("missing-value-stops");

    // Act
    const actual = resolveValues(rules, {}, {}, {});

    // Assert
    expect(actual).toEqual({
      ok: false,
      error: {
        message:
          "missing value for <YOUR_NAME>: add it to .user-values.json",
        code: 1,
      },
    });
  });

  test("cached beats inferred", () => {
    // Arrange
    const rules: readonly SanitizeRule[] = [
      { placeholder: "<A>", prompt: "A" },
    ];

    // Act
    const actual = resolveValues(
      rules,
      { "<A>": "cached" },
      { "<A>": "inferred" },
      {},
    );

    // Assert
    expect(actual).toEqual({ ok: true, value: { "<A>": "cached" } });
  });

  test("default then defaultEnv order", () => {
    // Arrange
    const withDefault: readonly SanitizeRule[] = [
      { placeholder: "<A>", prompt: "A", default: "from-default", defaultEnv: "E" },
    ];
    const withEnvOnly: readonly SanitizeRule[] = [
      { placeholder: "<A>", prompt: "A", defaultEnv: "E" },
    ];
    const env = { E: "from-env" };

    // Act
    const preferred = resolveValues(withDefault, {}, {}, env);
    const fallback = resolveValues(withEnvOnly, {}, {}, env);

    // Assert
    expect(preferred).toEqual({
      ok: true,
      value: { "<A>": "from-default" },
    });
    expect(fallback).toEqual({ ok: true, value: { "<A>": "from-env" } });
  });

  test("defaultenv-invalid (default env path)", () => {
    // Arrange
    const rules = caseRules("defaultenv-invalid");

    // Act
    const noValue = resolveValues(rules, {}, {}, {});
    const cached = resolveValues(
      rules,
      { "<YOUR_NAME>": "Parity User" },
      {},
      {},
    );

    // Assert
    // The invalid name is a config error the parser reports; this module only
    // reads values, so an unset name leaves the placeholder unresolved.
    expect(noValue).toEqual({
      ok: false,
      error: {
        message:
          "missing value for <YOUR_NAME>: add it to .user-values.json",
        code: 1,
      },
    });
    expect(cached).toEqual({
      ok: true,
      value: { "<YOUR_NAME>": "Parity User" },
    });
  });
});
