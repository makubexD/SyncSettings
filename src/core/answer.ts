/** Spaces, tabs and `\r` at either end of a typed answer. Not `\s`, so an
 * answer keeps the other Unicode whitespace it holds (phase 9, decision 8). */
const ANSWER_PADDING = /^[ \t\r]+|[ \t\r]+$/g;

/**
 * A typed answer as bash's `read` leaves it, plus the `\r` a Windows terminal
 * keeps: spaces, tabs and carriage returns at both ends dropped. An answer
 * that is only those counts as empty.
 */
export function trimAnswer(raw: string): string {
  return raw.replace(ANSWER_PADDING, "");
}

/** C0 and C1 control characters, and the Unicode format characters that
 * reorder or hide text (bidi overrides, zero-width marks, line separators,
 * the BOM), which a prompt must not echo to the terminal. */
const CONTROL_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

/**
 * Whether a value holds a character a typed answer can't: a value is one
 * line, as a typed answer is, so a newline or an escape character in a guess
 * or a `--value` is refused rather than saved and hydrated.
 */
export function holdsControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}
