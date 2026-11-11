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

const WORD_WIDTH = 10;

/**
 * One status line as bash `status()` prints it, without the line ending:
 * two spaces, the word left-aligned to 10 columns, the label, and a non-empty
 * note in parentheses after two spaces.
 */
export function formatLine(
  word: StatusWord,
  label: string,
  note?: string,
): string {
  const annotation = note === undefined || note === "" ? "" : `  (${note})`;
  return `  ${word.padEnd(WORD_WIDTH)} ${label}${annotation}`;
}
