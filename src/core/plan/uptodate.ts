/**
 * Contract "Up-to-date check": whether export and import should warn, ask or
 * stay silent about a repo behind `origin/master`. Pure: the app gathers the
 * facts through the git adapter and prints the lines this module returns.
 */

/** The branch the check applies to; any other branch is left alone. */
const MASTER = "master";

const NOTE_LINE =
  "  NOTE: could not reach origin; skipping the up-to-date check.";

/** Contract "Up-to-date check", a pull that fails: exit 1. */
export const PULL_FAILED = "ERROR: pull failed; resolve it and rerun.";

/** Contract "Up-to-date check", behind and without a terminal. */
function warningLine(behind: number): string {
  return `  WARNING: repo is ${behind} commit(s) behind origin/master; run git pull --ff-only.`;
}

/** Contract "Up-to-date check", behind with a terminal: the question. */
function askPrompt(behind: number): string {
  return `  Repo is ${behind} commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n] `;
}

/** Contract "Up-to-date check", after a pull: the run stops, exit 0. */
export function pulledLine(behind: number): string {
  return `  Pulled ${behind} commit(s); run the command again.`;
}

/** What the git adapter found, plus whether a human can answer a question. */
export interface UpToDateFacts {
  /** `git rev-parse --is-inside-work-tree` exited 0. */
  readonly isRepo: boolean;
  /** `git remote get-url origin` exited 0. */
  readonly hasOrigin: boolean;
  /** `git symbolic-ref --short -q HEAD`; `undefined` when detached. */
  readonly branch: string | undefined;
  /** `git fetch -q origin master` exited 0. */
  readonly fetchOk: boolean;
  /** Commits in `origin/master` that local `HEAD` lacks; 0 when unknown. */
  readonly behind: number;
  /** Stdin and stdout are both TTYs, so a question can be asked. */
  readonly terminal: boolean;
}

/**
 * What the run does: `none` prints nothing, `note` and `warning` print their
 * line and go on, and `ask` prints its prompt and pulls when the answer is yes.
 */
export type UpToDateAction =
  | { readonly kind: "none" }
  | { readonly kind: "note"; readonly line: string }
  | { readonly kind: "warning"; readonly line: string }
  | {
      readonly kind: "ask";
      readonly prompt: string;
      readonly behind: number;
    };

/**
 * Contract "Up-to-date check": a plain folder, no origin or a branch other
 * than `master` is silent; a failed fetch prints its note; a repo up to date
 * is silent; behind, it warns without a terminal and asks with one.
 */
export function upToDateAction(facts: UpToDateFacts): UpToDateAction {
  if (!facts.isRepo || !facts.hasOrigin || facts.branch !== MASTER) {
    return { kind: "none" };
  }
  if (!facts.fetchOk) {
    return { kind: "note", line: NOTE_LINE };
  }
  if (facts.behind <= 0) {
    return { kind: "none" };
  }
  if (!facts.terminal) {
    return { kind: "warning", line: warningLine(facts.behind) };
  }
  return {
    kind: "ask",
    prompt: askPrompt(facts.behind),
    behind: facts.behind,
  };
}
