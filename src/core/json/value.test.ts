import { describe, expect, test } from "bun:test";
import { jsonEqual, parseJson, writeJson } from "./value.ts";
import type { JsonValue } from "./value.ts";

const LF = "\n";
const CRLF = "\r\n";

const LAYOUT_TEXT = `{
  "name": "mksync",
  "version": 2,
  "enabled": true,
  "missing": null,
  "count": 1.0,
  "tags": [
    "a",
    "b"
  ],
  "nested": {
    "empty": {},
    "list": []
  }
}
`;

const DECIMAL_TEXT = "1.0";
const EXPONENT_TEXT = "1e3";
const BIG_INTEGER_TEXT = "12345678901234567890";

const NON_ASCII_VALUE: JsonValue = { kind: "string", value: "Zürich — 日本語" };
const NON_ASCII_JSON = '"Zürich — 日本語"\n';

const ESCAPED_E_ACUTE_TEXT = '"\\u00e9"';
const E_ACUTE_VALUE: JsonValue = { kind: "string", value: "é" };
const E_ACUTE_JSON = '"é"\n';

const EMPTY_OBJECT_TEXT = "{}";
const EMPTY_ARRAY_TEXT = "[]";

const DUPLICATE_KEY_TEXT = '{"a": 1, "a": 2}';
const DUPLICATE_KEY_ERROR = "duplicate key";

const COMMENT_TEXT = `{
  // a note
  "a": 1
}`;
const COMMENT_ERROR = "comment";

const TRAILING_COMMA_TEXT = '{"a": 1,}';
const TRAILING_COMMA_ERROR = "trailing comma";

const TRAILING_GARBAGE_TEXT = '{"a": 1} extra';
const TRAILING_GARBAGE_ERROR = "trailing garbage";

const OBJECT_TEXT = '{"a": 1}';
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const BOM_OBJECT_TEXT = `${BYTE_ORDER_MARK}${OBJECT_TEXT}`;
const BOM_IN_MIDDLE_TEXT = `[1,${BYTE_ORDER_MARK}2]`;
const UNEXPECTED_CHARACTER_ERROR = "unexpected character";

const MAX_DEPTH = 512;
const OVER_MAX_DEPTH = MAX_DEPTH + 1;
const DEEP_INPUT_LEVELS = 100000;
const TOO_DEEP_ERROR = "nesting too deep";
const INVALID_JSON_ERROR = { ok: false, error: TOO_DEEP_ERROR } as const;

const UNCLOSED_DEEP_TEXT = "[".repeat(DEEP_INPUT_LEVELS);

const PROTO_KEYS_TEXT = `{
  "__proto__": 1,
  "constructor": 2
}
`;
const PROTO_KEYS_VALUE: JsonValue = {
  kind: "object",
  entries: new Map<string, JsonValue>([
    ["__proto__", { kind: "number", text: "1" }],
    ["constructor", { kind: "number", text: "2" }],
  ]),
};

const REORDERED_KEYS_LEFT = '{"a": 1, "b": 2}';
const REORDERED_KEYS_RIGHT = '{"b": 2, "a": 1}';

const ARRAY_ITEMS_LEFT = "[1, 2]";
const ARRAY_ITEMS_RIGHT = "[2, 1]";

function parseOk(text: string): JsonValue {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new Error(`expected valid JSON, got ${parsed.error}`);
  }
  return parsed.value;
}

function nestedArrays(depth: number): string {
  return `${"[".repeat(depth)}${"]".repeat(depth)}`;
}

/** Alternates `[` and `{"a":` containers, so arrays and objects share the depth. */
function nestedMixedContainers(depth: number): string {
  let text = "";
  for (let level = 0; level < depth; level++) {
    text += level % 2 === 0 ? "[" : '{"a":';
  }
  text += "null";
  for (let level = depth - 1; level >= 0; level--) {
    text += level % 2 === 0 ? "]" : "}";
  }
  return text;
}

describe("parseJson and writeJson", () => {
  test("a file in the layout round-trips byte for byte", () => {
    // Arrange
    const source = LAYOUT_TEXT;

    // Act
    const written = writeJson(parseOk(source), LF);

    // Assert
    expect(written).toBe(source);
  });

  test("1.0 keeps its source text", () => {
    // Arrange
    const source = DECIMAL_TEXT;

    // Act
    const written = writeJson(parseOk(source), LF);

    // Assert
    expect(written).toBe(`${DECIMAL_TEXT}\n`);
  });

  test("1e3 keeps its source text", () => {
    // Arrange
    const source = EXPONENT_TEXT;

    // Act
    const written = writeJson(parseOk(source), LF);

    // Assert
    expect(written).toBe(`${EXPONENT_TEXT}\n`);
  });

  test("a big integer keeps its source text", () => {
    // Arrange
    const source = BIG_INTEGER_TEXT;

    // Act
    const written = writeJson(parseOk(source), LF);

    // Assert
    expect(written).toBe(`${BIG_INTEGER_TEXT}\n`);
  });

  test("non-ASCII is written as itself", () => {
    // Arrange
    const value = NON_ASCII_VALUE;

    // Act
    const written = writeJson(value, LF);

    // Assert
    expect(written).toBe(NON_ASCII_JSON);
  });

  test("\\u00e9 is read as é and written raw", () => {
    // Arrange
    const source = ESCAPED_E_ACUTE_TEXT;

    // Act
    const value = parseOk(source);
    const written = writeJson(value, LF);

    // Assert
    expect(value).toEqual(E_ACUTE_VALUE);
    expect(written).toBe(E_ACUTE_JSON);
  });

  test("an empty object is written as {}", () => {
    // Arrange
    const source = EMPTY_OBJECT_TEXT;

    // Act
    const written = writeJson(parseOk(source), LF);

    // Assert
    expect(written).toBe("{}\n");
  });

  test("an empty array is written as []", () => {
    // Arrange
    const source = EMPTY_ARRAY_TEXT;

    // Act
    const written = writeJson(parseOk(source), LF);

    // Assert
    expect(written).toBe("[]\n");
  });

  test("a duplicate key is refused", () => {
    // Arrange
    const source = DUPLICATE_KEY_TEXT;

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual({ ok: false, error: DUPLICATE_KEY_ERROR });
  });

  test("a comment is refused", () => {
    // Arrange
    const source = COMMENT_TEXT;

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual({ ok: false, error: COMMENT_ERROR });
  });

  test("a trailing comma is refused", () => {
    // Arrange
    const source = TRAILING_COMMA_TEXT;

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual({ ok: false, error: TRAILING_COMMA_ERROR });
  });

  test("trailing garbage is refused", () => {
    // Arrange
    const source = TRAILING_GARBAGE_TEXT;

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual({ ok: false, error: TRAILING_GARBAGE_ERROR });
  });

  test("a leading byte order mark is skipped", () => {
    // Arrange
    const source = BOM_OBJECT_TEXT;
    const withoutBom = parseOk(OBJECT_TEXT);

    // Act
    const value = parseOk(source);

    // Assert
    expect(value).toEqual(withoutBom);
  });

  test("a byte order mark in the middle is refused", () => {
    // Arrange
    const source = BOM_IN_MIDDLE_TEXT;

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual({ ok: false, error: UNEXPECTED_CHARACTER_ERROR });
  });

  test("512 nested arrays parse", () => {
    // Arrange
    const source = nestedArrays(MAX_DEPTH);

    // Act
    const value = parseOk(source);

    // Assert
    expect(value.kind).toBe("array");
  });

  test("513 nested arrays are refused", () => {
    // Arrange
    const source = nestedArrays(OVER_MAX_DEPTH);

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual(INVALID_JSON_ERROR);
  });

  test("513 nested mixed objects and arrays are refused", () => {
    // Arrange
    const source = nestedMixedContainers(OVER_MAX_DEPTH);

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual(INVALID_JSON_ERROR);
  });

  test("a very deep unclosed input is refused without throwing", () => {
    // Arrange
    const source = UNCLOSED_DEEP_TEXT;

    // Act
    const result = parseJson(source);

    // Assert
    expect(result).toEqual(INVALID_JSON_ERROR);
  });

  test("__proto__ and constructor are plain keys", () => {
    // Arrange
    const source = PROTO_KEYS_TEXT;

    // Act
    const value = parseOk(source);
    const written = writeJson(value, LF);

    // Assert
    expect(value).toEqual(PROTO_KEYS_VALUE);
    expect(written).toBe(source);
  });

  test("CRLF output uses CRLF on every line", () => {
    // Arrange
    const expected = LAYOUT_TEXT.replaceAll("\n", CRLF);

    // Act
    const written = writeJson(parseOk(LAYOUT_TEXT), CRLF);

    // Assert
    expect(written).toBe(expected);
  });

  test("CRLF output has no lone LF", () => {
    // Arrange
    const value = parseOk(LAYOUT_TEXT);

    // Act
    const written = writeJson(value, CRLF);

    // Assert
    const segments = written.split(CRLF);
    expect(segments.some((segment) => segment.includes(LF))).toBe(false);
    expect(segments.at(-1)).toBe("");
  });
});

describe("jsonEqual", () => {
  test("reordered object keys are equal", () => {
    // Arrange
    const left = parseOk(REORDERED_KEYS_LEFT);
    const right = parseOk(REORDERED_KEYS_RIGHT);

    // Act
    const equal = jsonEqual(left, right);

    // Assert
    expect(equal).toBe(true);
  });

  test("reordered array items are not equal", () => {
    // Arrange
    const left = parseOk(ARRAY_ITEMS_LEFT);
    const right = parseOk(ARRAY_ITEMS_RIGHT);

    // Act
    const equal = jsonEqual(left, right);

    // Assert
    expect(equal).toBe(false);
  });
});
