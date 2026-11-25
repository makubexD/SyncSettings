/** Contract "Conflict block": whether each side of a `BOTH` file has it. */
export interface ConflictSides {
  readonly theirs: boolean;
  readonly mine: boolean;
}

const INDENT = "  ";

/** `this machine` plus the three spaces before the path, so both paths align. */
const HEADER_LABEL_WIDTH = 15;

const REPO_LABEL = "repo";

const MINE_LABEL = "this machine";

const MISSING_SUFFIX = " (missing)";

const HUNK_PREFIX = "@@";

const BINARY_PREFIX = "Binary files ";

const BINARY_SUFFIX = " differ";

const BINARY_BODY = "binary files differ";

const MAX_BODY_LINES = 40;

const MAX_LINE_LENGTH = 200;

/** Control and text-direction characters, tab excepted: a terminal would act
 * on them instead of showing them. */
const UNSAFE =
  /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200e\u200f\u061c\u2028-\u202e\u2066-\u2069]/g;

/** `text` with every unsafe character as `\u` and its four-digit code. */
function visible(text: string): string {
  return text.replace(
    UNSAFE,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A body line as it is shown: visible, and cut when it is very long. */
function shownLine(line: string): string {
  const characters = [...line.slice(0, 2 * MAX_LINE_LENGTH + 2)];
  return characters.length > MAX_LINE_LENGTH
    ? `${INDENT}${visible(characters.slice(0, MAX_LINE_LENGTH).join(""))}…`
    : `${INDENT}${visible(line)}`;
}

function headerLine(
  mark: "---" | "+++",
  label: string,
  path: string,
  present: boolean,
): string {
  const missing = present ? "" : MISSING_SUFFIX;
  return `${INDENT}${mark} ${label.padEnd(HEADER_LABEL_WIDTH)}${visible(path)}${missing}`;
}

/** The diff lines from the first hunk on, or git's binary notice. */
function bodyLines(diff: string): readonly string[] {
  const lines = diff.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const hunk = lines.findIndex((line) => line.startsWith(HUNK_PREFIX));
  if (hunk !== -1) {
    return lines.slice(hunk);
  }
  const binary = lines.some(
    (line) => line.startsWith(BINARY_PREFIX) && line.endsWith(BINARY_SUFFIX),
  );
  return binary ? [BINARY_BODY] : [];
}

/**
 * Contract "Conflict block": the lines shown for one `BOTH` file. `diff` is
 * `git diff --no-index`'s stdout from `theirs` to `mine`, header included.
 */
export function conflictBlock(
  path: string,
  sides: ConflictSides,
  diff: string,
): readonly string[] {
  const headers = [
    headerLine("---", REPO_LABEL, path, sides.theirs),
    headerLine("+++", MINE_LABEL, path, sides.mine),
  ];
  const body = bodyLines(diff);
  const shown = body.slice(0, MAX_BODY_LINES).map(shownLine);
  const leftOut = body.length - shown.length;
  return leftOut > 0
    ? [...headers, ...shown, `${INDENT}… ${leftOut} more line(s)`]
    : [...headers, ...shown];
}
