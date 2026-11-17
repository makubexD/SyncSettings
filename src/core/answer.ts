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
