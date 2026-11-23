/**
 * The diff-label rules of pull's guard, shared with setup: which diff lines
 * block an overwrite, and the `IN` / `OUT` / `BOTH` counts setup's differ line
 * names. Only the parsing lives here; pull and setup keep their own wording.
 */

import type { RunCommand } from "../cli/parse.ts";
import type { Result } from "./export.ts";

/** A diff label line the guard stops on: `formatLine` leaves two spaces, the
 * word and one more space. */
const BLOCKED_LINE = /^ {2}(?:OUT|BOTH) /;

const IN_LINE = /^ {2}IN /;

const OUT_LINE = /^ {2}OUT /;

const BOTH_LINE = /^ {2}BOTH /;

/** The diff's `OUT` and `BOTH` lines, in the order it printed them. */
export function blockedLines(diff: Result): readonly string[] {
  const lines = `${diff.stdout}${diff.stderr}`.split("\n");
  return lines.filter((line) => BLOCKED_LINE.test(line));
}

/** The `IN`, `OUT` and `BOTH` counts a diff printed, for setup's differ line. */
export interface DiffCounts {
  readonly inCount: number;
  readonly outCount: number;
  readonly bothCount: number;
}

/** Count the diff's `IN`, `OUT` and `BOTH` label lines. */
export function diffCounts(diff: Result): DiffCounts {
  let inCount = 0;
  let outCount = 0;
  let bothCount = 0;
  for (const line of `${diff.stdout}${diff.stderr}`.split("\n")) {
    if (IN_LINE.test(line)) {
      inCount += 1;
    } else if (OUT_LINE.test(line)) {
      outCount += 1;
    } else if (BOTH_LINE.test(line)) {
      bothCount += 1;
    }
  }
  return { inCount, outCount, bothCount };
}

/** A pull child's `import`: the check (`--check`) or the forced apply. Setup's
 * differ line runs the same check. */
export function pullImportCommand(
  check: boolean,
  force: boolean,
  only: readonly string[],
): RunCommand {
  return {
    kind: "run",
    command: "import",
    force,
    preview: false,
    check,
    resetValues: false,
    yes: false,
    only,
  };
}

/** A child's `export --diff`, narrowed to the pulled or picked paths. Setup's
 * guard runs the same diff over every path. */
export function diffCommand(only: readonly string[]): RunCommand {
  return {
    kind: "run",
    command: "export",
    force: false,
    preview: false,
    check: false,
    resetValues: false,
    yes: false,
    diff: true,
    only,
  };
}
