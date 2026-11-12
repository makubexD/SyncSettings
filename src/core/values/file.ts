import type { Values } from "./sanitize.ts";

/** Indent of the saved file, as `jq` prints it. */
const JSON_INDENT = 2;

/**
 * The text of `.user-values.json` (contract "Where values come from"): every
 * value, keys sorted, two-space indent and a trailing newline, as the bash
 * engine's `jq -S` writes it.
 */
export function valuesFileText(values: Values): string {
  const sorted = Object.fromEntries(
    Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  // shortcut: JSON.stringify leaves U+007F unescaped where jq writes \u007f;
  // no placeholder value is expected to hold it.
  return `${JSON.stringify(sorted, null, JSON_INDENT)}\n`;
}

/** A value's text, jq's `tostring`: a number or boolean keeps its spelling. */
function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value);
}

/** `.user-values.json`'s text as values keyed by placeholder. */
export function parseValuesFile(text: string | undefined): Values {
  if (text === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A broken values file must not stop the run; a missing value stops it later.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [placeholder, value] of Object.entries(parsed)) {
    values[placeholder] = valueText(value);
  }
  return values;
}
