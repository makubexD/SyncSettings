import { describe, expect, test } from "bun:test";
import { jsonEqual } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerName } from "../layers/select.ts";
import { mergeJsonValues, parseJsonBytes } from "../merge/json.ts";
import type { JsonLayer } from "../merge/json.ts";
import { moveJsonChange, moveWholeFile } from "./move.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const EOL = "\n";
const WRITE_ITEM: JsonValue = { kind: "string", value: "write" };

function slot(name: LayerName, text: string | undefined): JsonLayer {
  return {
    name,
    repoPath: `dotfiles/${name}/settings.json`,
    bytes: text === undefined ? undefined : ENCODER.encode(text),
  };
}

function textOf(layer: JsonLayer | undefined): string | undefined {
  return layer?.bytes === undefined ? undefined : DECODER.decode(layer.bytes);
}

function layerNamed(
  slots: readonly JsonLayer[],
  name: LayerName,
): JsonLayer | undefined {
  return slots.find((layer) => layer.name === name);
}

/** The merge of the slots that hold a file, which a move must not change. */
function mergedValues(slots: readonly JsonLayer[]): JsonValue {
  const values = slots
    .map((layer) =>
      layer.bytes === undefined ? undefined : parseJsonBytes(layer.bytes),
    )
    .filter((value): value is JsonValue => value !== undefined);
  return mergeJsonValues(values);
}

function expectSameMerge(
  before: readonly JsonLayer[],
  after: readonly JsonLayer[],
): void {
  expect(jsonEqual(mergedValues(before), mergedValues(after))).toBe(true);
}

describe("moveJsonChange", () => {
  test("key narrowed to profile: both layers hold it and the profile overrides", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("os", undefined),
      slot("profile", '{"editor.fontSize": 15}'),
      slot("machine", undefined),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    // The source layer's bytes stay as they are.
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{"editor.fontSize": 14}',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{\n  "editor.fontSize": 15\n}\n',
    );
  });

  test("key widened to base: base holds it and profile no longer does", () => {
    const before = [
      slot("base", '{"editor.tabSize": 2}'),
      slot("os", undefined),
      slot("profile", '{"editor.fontSize": 14}'),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      "key",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "editor.tabSize": 2,\n  "editor.fontSize": 14\n}\n',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe("{}\n");
  });

  test("key widened to base with the os layer setting it: profile keeps it", () => {
    const before = [
      slot("base", '{"editor.tabSize": 2}'),
      slot("os", '{"editor.fontSize": 13}'),
      slot("profile", '{"editor.fontSize": 14}'),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      "key",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "editor.tabSize": 2,\n  "editor.fontSize": 14\n}\n',
    );
    // The intermediate os layer sets the path, so the profile keeps it.
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{"editor.fontSize": 14}',
    );
  });

  test("array item widened from profile to base", () => {
    const before = [
      slot("base", '{"permissions": {"allow": ["read"]}}'),
      slot("os", undefined),
      slot("profile", '{"permissions": {"allow": ["write", "edit"]}}'),
    ];
    const result = moveJsonChange(
      before,
      "permissions.allow[]",
      "item",
      "profile",
      "base",
      EOL,
      WRITE_ITEM,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "read",\n      "write"\n    ]\n  }\n}\n',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "edit"\n    ]\n  }\n}\n',
    );
  });

  test("an item move without the item is an error", () => {
    const before = [
      slot("base", '{"allow": ["read"]}'),
      slot("profile", '{"allow": ["write"]}'),
    ];
    const result = moveJsonChange(
      before,
      "allow[]",
      "item",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(false);
  });

  test("an object key widened to base keeps the keys only base held", () => {
    const before = [
      slot("base", '{"editor": {"tabSize": 2, "wrap": true}}'),
      slot("os", undefined),
      slot("profile", '{"editor": {"tabSize": 4}}'),
    ];
    const result = moveJsonChange(
      before,
      "editor",
      "key",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "editor": {\n    "tabSize": 4,\n    "wrap": true\n  }\n}\n',
    );
  });

  test("a target slot with no file yet gets one", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", undefined),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{"editor.fontSize": 14}',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{\n  "editor.fontSize": 14\n}\n',
    );
  });

  test("the same layer leaves the slots unchanged", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", '{"editor.fontSize": 15}'),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      "key",
      "profile",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toBe(before);
    expectSameMerge(before, result.value);
  });

  test("a path the source doesn't hold is an error", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", undefined),
    ];
    const result = moveJsonChange(
      before,
      "editor.tabSize",
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("editor.tabSize");
  });

  test("a slot that isn't valid JSON is an error", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", "{oops"),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("not valid JSON: dotfiles/profile/settings.json");
  });
});

describe("moveWholeFile", () => {
  test("the whole file moves from base to machine", () => {
    const before = [slot("base", '{"a": 1}'), slot("machine", undefined)];
    const result = moveWholeFile(before, "base", "machine");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(layerNamed(result.value, "base")?.bytes).toBeUndefined();
    // A whole file moves as its bytes are, without a rewrite.
    expect(textOf(layerNamed(result.value, "machine"))).toBe('{"a": 1}');
  });

  test("a wider move keeps the source when a layer between has the file", () => {
    const before = [
      slot("base", undefined),
      slot("os", '{"a": 2}'),
      slot("machine", '{"a": 3}'),
    ];
    const result = moveWholeFile(before, "machine", "base");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "machine"))).toBe('{"a": 3}');
  });

  test("a narrower move past a layer that has the file is an error", () => {
    const before = [
      slot("base", '{"a": 1}'),
      slot("os", '{"a": 2}'),
      slot("machine", undefined),
    ];
    const result = moveWholeFile(before, "base", "machine");
    expect(result.ok).toBe(false);
  });
});
