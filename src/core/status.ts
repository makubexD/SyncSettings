/** Every status word the contract's "Statuses" tables name. */
export const STATUS_WORDS = [
  "SKIPPED",
  "ADDED",
  "UNCHANGED",
  "MODIFIED",
  "REMOVED",
  "ERROR",
  "CREATED",
  "UPDATED",
  "EXTRA",
  "ORPHAN",
  "DRIFT",
] as const;

export type StatusWord = (typeof STATUS_WORDS)[number];

/**
 * The diff's labels. `formatLine` prints them, but they stay out of
 * `STATUS_WORDS`: that list is the import and export status words, which build
 * a regular expression and enumerate the words they print.
 */
export type DiffWord = "IN" | "OUT" | "BOTH" | "?";

/** Any word `formatLine` prints. */
export type LineWord = StatusWord | DiffWord;

const WORD_WIDTH = 10;

/**
 * One status line as bash `status()` prints it, without the line ending:
 * two spaces, the word left-aligned to 10 columns, the label, and a non-empty
 * note in parentheses after two spaces.
 */
export function formatLine(
  word: LineWord,
  label: string,
  note?: string,
): string {
  const annotation = note === undefined || note === "" ? "" : `  (${note})`;
  return `  ${word.padEnd(WORD_WIDTH)} ${label}${annotation}`;
}
