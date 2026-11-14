import type { SanitizeRule } from "../config/types.ts";

/** Values keyed by placeholder, as `.user-values.json` holds them. */
export type Values = Readonly<Record<string, string>>;

export interface SanitizeOptions {
  readonly json: boolean;
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  if (needle.length === 0) {
    return from <= haystack.length ? from : -1;
  }
  const last = haystack.length - needle.length;
  outer: for (let i = Math.max(from, 0); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

export function replaceAllBytes(
  content: Uint8Array,
  needle: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  if (needle.length === 0) {
    return content;
  }
  const parts: Uint8Array[] = [];
  let start = 0;
  let found = indexOfBytes(content, needle, start);
  while (found !== -1) {
    parts.push(content.subarray(start, found), replacement);
    start = found + needle.length;
    found = indexOfBytes(content, needle, start);
  }
  if (parts.length === 0) {
    return content;
  }
  parts.push(content.subarray(start));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const TOKEN_START = 0x01;
const TOKEN_FILL = 0x02;
const TOKEN_END = 0x03;

/**
 * The i-th placeholder's token: \x01, i+1 copies of \x02, \x03. A token is
 * never a prefix of another token, so replacing tokens in two passes keeps
 * inserted placeholders and values from being scanned again.
 */
export function placeholderToken(index: number): Uint8Array {
  const token = new Uint8Array(index + 3);
  token[0] = TOKEN_START;
  token.fill(TOKEN_FILL, 1, index + 2);
  token[index + 2] = TOKEN_END;
  return token;
}

/** The body of a JSON string literal, as hydrate writes a value into a JSON file. */
export function jsonStringBody(value: string): string {
  const encoded = JSON.stringify(value) as string | undefined;
  if (encoded === undefined) {
    throw new TypeError(
      "JSON.stringify returned undefined for a string value.",
    );
  }
  return encoded.slice(1, -1);
}

function characterLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Placeholders whose value is not empty, longest value first as the bash
 * engine orders them (`_placeholders_by_length`): ties compare the
 * placeholder itself, descending.
 */
export function placeholdersByLength(
  rules: readonly SanitizeRule[],
  values: Values,
): readonly string[] {
  const selected: string[] = [];
  for (const rule of rules) {
    const placeholder = rule.placeholder;
    const value = values[placeholder];
    if (placeholder.length === 0 || value === undefined || value.length === 0) {
      continue;
    }
    selected.push(placeholder);
  }
  const unique = [...new Set(selected)];
  unique.sort((a, b) => {
    const aLength = characterLength(values[a] ?? "");
    const bLength = characterLength(values[b] ?? "");
    if (aLength !== bLength) {
      return bLength - aLength;
    }
    if (a === b) {
      return 0;
    }
    return a < b ? 1 : -1;
  });
  return unique;
}

/**
 * The forms `value` takes in a file, in the order sanitize replaces them: its
 * JSON string body when `json`, its backslashes doubled, then the value
 * itself.
 */
export function formsFor(value: string, json: boolean): readonly string[] {
  const forms: string[] = [];
  if (json) {
    forms.push(jsonStringBody(value));
  }
  const doubled = value.replaceAll("\\", "\\\\");
  if (doubled !== value && !forms.includes(doubled)) {
    forms.push(doubled);
  }
  if (!forms.includes(value)) {
    forms.push(value);
  }
  return forms;
}

export function sanitize(
  content: Uint8Array,
  rules: readonly SanitizeRule[],
  values: Values,
  options: SanitizeOptions,
): Uint8Array {
  const placeholders = placeholdersByLength(rules, values);
  let result = content;
  for (const [index, placeholder] of placeholders.entries()) {
    const value = values[placeholder];
    if (value === undefined) {
      continue;
    }
    const token = placeholderToken(index);
    for (const form of formsFor(value, options.json)) {
      result = replaceAllBytes(result, encodeUtf8(form), token);
    }
  }
  for (const [index, placeholder] of placeholders.entries()) {
    result = replaceAllBytes(
      result,
      placeholderToken(index),
      encodeUtf8(placeholder),
    );
  }
  return result;
}
