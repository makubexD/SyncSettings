import { describe, expect, test } from "bun:test";
import { onlyRemoves } from "./removal.ts";
import { parseJson } from "./value.ts";
import type { JsonValue } from "./value.ts";

function json(text: string): JsonValue {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

describe("onlyRemoves", () => {
  test.each([
    ["equal", '{"a":1}', '{"a":1}', true],
    ["key removed", '{"a":1,"b":2}', '{"a":1}', true],
    ["nested key removed", '{"a":{"b":1,"c":2}}', '{"a":{"c":2}}', true],
    ["item removed", '{"a":[1,2]}', '{"a":[2]}', true],
    ["all removed", '{"a":1}', "{}", true],
    ["key added", '{"a":1}', '{"a":1,"b":2}', false],
    ["one removed, one added", '{"a":1}', '{"b":2}', false],
    ["value changed", '{"a":1}', '{"a":2}', false],
    ["item added", '{"a":[1]}', '{"a":[1,2]}', false],
    ["item repeated", '{"a":[1]}', '{"a":[1,1]}', false],
    ["kind changed", '{"a":[1]}', '{"a":{}}', false],
  ])("%s", (_name, before, after, expected) => {
    expect(onlyRemoves(json(before), json(after))).toBe(expected);
  });
});
