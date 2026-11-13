import type { Result } from "../config/types.ts";

/**
 * A JSON value as the layer merge sees it: a tagged union, objects in source
 * order, numbers keeping their source text, strings decoded.
 */
export type JsonValue =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly JsonValue[] }
  | { readonly kind: "object"; readonly entries: ReadonlyMap<string, JsonValue> };

const UNEXPECTED_END = "unexpected end of input";
const UNEXPECTED_CHARACTER = "unexpected character";
const UNTERMINATED_STRING = "unterminated string";
const INVALID_ESCAPE = "invalid escape";
const RAW_CONTROL_CHARACTER = "raw control character in string";
const DUPLICATE_KEY = "duplicate key";
const COMMENT = "comment";
const TRAILING_COMMA = "trailing comma";
const TRAILING_GARBAGE = "trailing garbage";
const TOO_DEEP = "nesting too deep";

const MAX_DEPTH = 512;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const INDENT = "  ";
const FIRST_PRINTABLE = 0x20;
const SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const SURROGATE_SHIFT = 10;
const SUPPLEMENTARY_OFFSET = 0x10000;

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isNonZeroDigit(char: string): boolean {
  return char >= "1" && char <= "9";
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isHexDigit(char: string): boolean {
  return (
    isDigit(char) ||
    (char >= "a" && char <= "f") ||
    (char >= "A" && char <= "F")
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

function error(message: string): Result<never, string> {
  return { ok: false, error: message };
}

/**
 * A strict RFC 8259 parser. Duplicate keys, comments, trailing commas, trailing
 * garbage, raw control characters and invalid escapes are all refused. A byte
 * order mark at the very start of the text is skipped; one anywhere else is
 * refused. Nesting deeper than `MAX_DEPTH` is refused rather than overflowing
 * the stack.
 */
class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly text: string) {}

  parse(): Result<JsonValue, string> {
    this.skipByteOrderMark();
    this.skipWhitespace();
    const value = this.parseValue();
    if (!value.ok) {
      return value;
    }
    this.skipWhitespace();
    if (this.index < this.text.length) {
      return error(this.startsComment() ? COMMENT : TRAILING_GARBAGE);
    }
    return value;
  }

  private skipByteOrderMark(): void {
    if (this.text.startsWith(BYTE_ORDER_MARK)) {
      this.index = BYTE_ORDER_MARK.length;
    }
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.text.charAt(this.index))) {
      this.index++;
    }
  }

  private startsComment(): boolean {
    if (this.text.charAt(this.index) !== "/") {
      return false;
    }
    const next = this.text.charAt(this.index + 1);
    return next === "/" || next === "*";
  }

  private parseValue(): Result<JsonValue, string> {
    const char = this.text.charAt(this.index);
    if (char === "") {
      return error(UNEXPECTED_END);
    }
    switch (char) {
      case "{":
        return this.parseNested(() => this.parseObject());
      case "[":
        return this.parseNested(() => this.parseArray());
      case '"': {
        const parsed = this.parseString();
        return parsed.ok
          ? { ok: true, value: { kind: "string", value: parsed.value } }
          : parsed;
      }
      case "t":
        return this.parseLiteral("true", { kind: "bool", value: true });
      case "f":
        return this.parseLiteral("false", { kind: "bool", value: false });
      case "n":
        return this.parseLiteral("null", { kind: "null" });
      case "-":
        return this.parseNumber();
      case "/":
        return error(this.startsComment() ? COMMENT : UNEXPECTED_CHARACTER);
      default:
        return isDigit(char)
          ? this.parseNumber()
          : error(UNEXPECTED_CHARACTER);
    }
  }

  private parseNested(
    parseContainer: () => Result<JsonValue, string>,
  ): Result<JsonValue, string> {
    if (this.depth >= MAX_DEPTH) {
      return error(TOO_DEEP);
    }
    this.depth++;
    const value = parseContainer();
    this.depth--;
    return value;
  }

  private parseLiteral(
    text: string,
    value: JsonValue,
  ): Result<JsonValue, string> {
    if (!this.text.startsWith(text, this.index)) {
      return error(UNEXPECTED_CHARACTER);
    }
    this.index += text.length;
    return { ok: true, value };
  }

  private parseNumber(): Result<JsonValue, string> {
    const start = this.index;
    if (this.text.charAt(this.index) === "-") {
      this.index++;
    }
    const first = this.text.charAt(this.index);
    if (first === "0") {
      this.index++;
    } else if (isNonZeroDigit(first)) {
      while (isDigit(this.text.charAt(this.index))) {
        this.index++;
      }
    } else {
      return error(UNEXPECTED_CHARACTER);
    }
    if (this.text.charAt(this.index) === ".") {
      this.index++;
      if (!isDigit(this.text.charAt(this.index))) {
        return error(UNEXPECTED_CHARACTER);
      }
      while (isDigit(this.text.charAt(this.index))) {
        this.index++;
      }
    }
    const exponent = this.text.charAt(this.index);
    if (exponent === "e" || exponent === "E") {
      this.index++;
      const sign = this.text.charAt(this.index);
      if (sign === "+" || sign === "-") {
        this.index++;
      }
      if (!isDigit(this.text.charAt(this.index))) {
        return error(UNEXPECTED_CHARACTER);
      }
      while (isDigit(this.text.charAt(this.index))) {
        this.index++;
      }
    }
    return {
      ok: true,
      value: { kind: "number", text: this.text.slice(start, this.index) },
    };
  }

  private parseArray(): Result<JsonValue, string> {
    this.index++;
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text.charAt(this.index) === "]") {
      this.index++;
      return { ok: true, value: { kind: "array", items } };
    }
    for (;;) {
      const item = this.parseValue();
      if (!item.ok) {
        return item;
      }
      items.push(item.value);
      this.skipWhitespace();
      if (this.startsComment()) {
        return error(COMMENT);
      }
      const char = this.text.charAt(this.index);
      if (char === ",") {
        this.index++;
        this.skipWhitespace();
        if (this.text.charAt(this.index) === "]") {
          return error(TRAILING_COMMA);
        }
        continue;
      }
      if (char === "]") {
        this.index++;
        return { ok: true, value: { kind: "array", items } };
      }
      return error(char === "" ? UNEXPECTED_END : UNEXPECTED_CHARACTER);
    }
  }

  private parseObject(): Result<JsonValue, string> {
    this.index++;
    const entries = new Map<string, JsonValue>();
    this.skipWhitespace();
    if (this.text.charAt(this.index) === "}") {
      this.index++;
      return { ok: true, value: { kind: "object", entries } };
    }
    for (;;) {
      if (this.startsComment()) {
        return error(COMMENT);
      }
      if (this.text.charAt(this.index) !== '"') {
        return error(
          this.text.charAt(this.index) === ""
            ? UNEXPECTED_END
            : UNEXPECTED_CHARACTER,
        );
      }
      const key = this.parseString();
      if (!key.ok) {
        return key;
      }
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== ":") {
        return error(
          this.text.charAt(this.index) === ""
            ? UNEXPECTED_END
            : UNEXPECTED_CHARACTER,
        );
      }
      this.index++;
      this.skipWhitespace();
      const value = this.parseValue();
      if (!value.ok) {
        return value;
      }
      if (entries.has(key.value)) {
        return error(DUPLICATE_KEY);
      }
      entries.set(key.value, value.value);
      this.skipWhitespace();
      if (this.startsComment()) {
        return error(COMMENT);
      }
      const char = this.text.charAt(this.index);
      if (char === ",") {
        this.index++;
        this.skipWhitespace();
        if (this.text.charAt(this.index) === "}") {
          return error(TRAILING_COMMA);
        }
        continue;
      }
      if (char === "}") {
        this.index++;
        return { ok: true, value: { kind: "object", entries } };
      }
      return error(char === "" ? UNEXPECTED_END : UNEXPECTED_CHARACTER);
    }
  }

  private parseString(): Result<string, string> {
    this.index++;
    let value = "";
    for (;;) {
      const char = this.text.charAt(this.index);
      if (char === "") {
        return error(UNTERMINATED_STRING);
      }
      if (char === '"') {
        this.index++;
        return { ok: true, value };
      }
      if (char === "\\") {
        const escaped = this.parseEscape();
        if (!escaped.ok) {
          return escaped;
        }
        value += escaped.value;
        continue;
      }
      if ((char.codePointAt(0) ?? 0) < FIRST_PRINTABLE) {
        return error(RAW_CONTROL_CHARACTER);
      }
      value += char;
      this.index++;
    }
  }

  private parseEscape(): Result<string, string> {
    this.index++;
    const char = this.text.charAt(this.index);
    switch (char) {
      case '"':
        this.index++;
        return { ok: true, value: '"' };
      case "\\":
        this.index++;
        return { ok: true, value: "\\" };
      case "/":
        this.index++;
        return { ok: true, value: "/" };
      case "b":
        this.index++;
        return { ok: true, value: "\b" };
      case "f":
        this.index++;
        return { ok: true, value: "\f" };
      case "n":
        this.index++;
        return { ok: true, value: "\n" };
      case "r":
        this.index++;
        return { ok: true, value: "\r" };
      case "t":
        this.index++;
        return { ok: true, value: "\t" };
      case "u":
        return this.parseUnicodeEscape();
      default:
        return error(INVALID_ESCAPE);
    }
  }

  private parseUnicodeEscape(): Result<string, string> {
    // `index` points at the `u`; the four hex digits follow it.
    const first = this.readCodeUnit(this.index + 1);
    if (first === undefined) {
      return error(INVALID_ESCAPE);
    }
    if (isHighSurrogate(first)) {
      const lowStart = this.index + 5;
      if (
        this.text.charAt(lowStart) !== "\\" ||
        this.text.charAt(lowStart + 1) !== "u"
      ) {
        return error(INVALID_ESCAPE);
      }
      const second = this.readCodeUnit(lowStart + 2);
      if (second === undefined || !isLowSurrogate(second)) {
        return error(INVALID_ESCAPE);
      }
      const codePoint =
        SUPPLEMENTARY_OFFSET +
        ((first - SURROGATE_START) << SURROGATE_SHIFT) +
        (second - LOW_SURROGATE_START);
      this.index = lowStart + 6;
      return { ok: true, value: String.fromCodePoint(codePoint) };
    }
    if (isLowSurrogate(first)) {
      return error(INVALID_ESCAPE);
    }
    this.index += 5;
    return { ok: true, value: String.fromCharCode(first) };
  }

  private readCodeUnit(at: number): number | undefined {
    if (at + 4 > this.text.length) {
      return undefined;
    }
    const digits = this.text.slice(at, at + 4);
    for (const digit of digits) {
      if (!isHexDigit(digit)) {
        return undefined;
      }
    }
    return Number.parseInt(digits, 16);
  }
}

/**
 * A JSON text parsed strictly against RFC 8259. Whitespace outside values is
 * allowed, and a byte order mark at the very start of the text is skipped;
 * nesting deeper than `MAX_DEPTH` levels is refused. The error is a short note
 * such as `duplicate key`.
 */
export function parseJson(text: string): Result<JsonValue, string> {
  return new Parser(text).parse();
}

function escapeString(value: string): string {
  let escaped = '"';
  for (const char of value) {
    switch (char) {
      case '"':
        escaped += '\\"';
        continue;
      case "\\":
        escaped += "\\\\";
        continue;
      case "\b":
        escaped += "\\b";
        continue;
      case "\f":
        escaped += "\\f";
        continue;
      case "\n":
        escaped += "\\n";
        continue;
      case "\r":
        escaped += "\\r";
        continue;
      case "\t":
        escaped += "\\t";
        continue;
      default: {
        const code = char.codePointAt(0) ?? 0;
        escaped +=
          code < FIRST_PRINTABLE
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : char;
      }
    }
  }
  return `${escaped}"`;
}

function writeArray(
  items: readonly JsonValue[],
  indent: string,
  eol: string,
): string {
  if (items.length === 0) {
    return "[]";
  }
  const inner = `${indent}${INDENT}`;
  const lines = items.map((item) => `${inner}${writeValue(item, inner, eol)}`);
  return `[${eol}${lines.join(`,${eol}`)}${eol}${indent}]`;
}

function writeObject(
  entries: ReadonlyMap<string, JsonValue>,
  indent: string,
  eol: string,
): string {
  if (entries.size === 0) {
    return "{}";
  }
  const inner = `${indent}${INDENT}`;
  const lines: string[] = [];
  for (const [key, value] of entries) {
    lines.push(`${inner}${escapeString(key)}: ${writeValue(value, inner, eol)}`);
  }
  return `{${eol}${lines.join(`,${eol}`)}${eol}${indent}}`;
}

function writeValue(value: JsonValue, indent: string, eol: string): string {
  switch (value.kind) {
    case "null":
      return "null";
    case "bool":
      return value.value ? "true" : "false";
    case "number":
      return value.text;
    case "string":
      return escapeString(value.value);
    case "array":
      return writeArray(value.items, indent, eol);
    case "object":
      return writeObject(value.entries, indent, eol);
    default: {
      const unhandled: never = value;
      throw new Error(`Unhandled JSON value: ${String(unhandled)}`);
    }
  }
}

/**
 * The layout of the contract: two-space indent, one key or item per line,
 * `": "` after a key, `{}` and `[]` when empty, non-ASCII as itself, and a
 * trailing line ending.
 */
export function writeJson(value: JsonValue, eol: "\n" | "\r\n"): string {
  return `${writeValue(value, "", eol)}${eol}`;
}

function arrayEqual(
  left: readonly JsonValue[],
  right: readonly JsonValue[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem === undefined ||
      rightItem === undefined ||
      !jsonEqual(leftItem, rightItem)
    ) {
      return false;
    }
  }
  return true;
}

function objectEqual(
  left: ReadonlyMap<string, JsonValue>,
  right: ReadonlyMap<string, JsonValue>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || !jsonEqual(value, other)) {
      return false;
    }
  }
  return true;
}

/** Deep equality: object key order ignored, array item order significant. */
export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  switch (left.kind) {
    case "null":
      return right.kind === "null";
    case "bool":
      return right.kind === "bool" && left.value === right.value;
    case "number":
      return right.kind === "number" && left.text === right.text;
    case "string":
      return right.kind === "string" && left.value === right.value;
    case "array":
      return right.kind === "array" && arrayEqual(left.items, right.items);
    case "object":
      return right.kind === "object" && objectEqual(left.entries, right.entries);
    default: {
      const unhandled: never = left;
      throw new Error(`Unhandled JSON value: ${String(unhandled)}`);
    }
  }
}
