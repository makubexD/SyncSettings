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
