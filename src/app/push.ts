/**
 * `mksync push` (contract "Front door", the push row and the program note):
 * run the export, report when the repo already matches this machine, and
 * otherwise show the repo's changes, ask, and commit. Mirrors
 * `scripts/linux/front.sh` `front_push`.
 *
 * The pull-only refusal, the "Move a change" questions and the export's other
 * questions come from the export the flow runs; this module only orders it
 * with the behind-origin check, the PR question and the commit. Every effect
 * is a dependency, so the flow is testable without git, a terminal or a repo.
 */

import { trimAnswer } from "../core/answer.ts";
import type { Result as CoreResult } from "../core/config/types.ts";
import type { Result } from "./export.ts";

/** What the parsed command asks a push to do. */
export interface PushInput {
  readonly yes: boolean;
  readonly message?: string;
  readonly paths: readonly string[];
}

/** `git status --short` over the sync paths; `ok` is false when git can't
 * tell. */
export interface StatusResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/** What the "Move a change" loop asks: how many lines the block lists, which
 * group each change is in, the target wording, and the move itself. */
export interface MoveSession {
  /** The number of changes the block lists. */
  readonly lineCount: number;
  /** Which group the change on `line` is in: 1 all machines, 2 this OS,
   * 3 profile, 4 this machine. */
  groupOf(line: number): 1 | 2 | 3 | 4;
  /** The targets after "Move it to?", e.g. "1) all machines  2) Linux
   * machines  3) profile work-1  4) this machine". */
  readonly targets: string;
  /** Move the change on `line` to `group`; `ok` is the block printed again. */
  move(line: number, group: 1 | 2 | 3 | 4): CoreResult<string, string>;
}

/** What the behind-origin check reads after `git fetch -q origin master`. */
export interface OriginState {
  /** The fetch succeeded; false skips the behind check, as the contract
   * says. */
  readonly fetchOk: boolean;
  /** The commits `HEAD` lacks from `origin/master`. */
  readonly behind: number;
}

/** What a push runs; `only` is the push's picked paths. */
export interface PushDeps {
  /** `export` with the picked paths; `--yes` takes the new settings'
   * suggestions. */
  readonly runExport: (
    only: readonly string[],
    yes: boolean,
  ) => Promise<Result>;
  /** `git status --short` over the sync paths. */
  readonly statusShort: () => Promise<StatusResult>;
  /** Print `question` and read one answer; an empty answer or end of input
   * takes `defaultYes`. */
  readonly ask: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Write a result's stdout and stderr now, so a question follows them. */
  readonly print: (shown: Result) => void;
  /** `commit`, `--partial` when the push had picked paths. */
  readonly runCommit: (
    partial: boolean,
    message: string | undefined,
  ) => Promise<Result>;
  /** The clone is on `master` with an `origin` remote. */
  readonly cloneReady: () => Promise<boolean>;
  /** `git fetch -q origin master` and the commits `HEAD` lacks. */
  readonly originState: () => Promise<OriginState>;
}

/** `front_require_clone push`. */
const CLONE_ERROR =
  "ERROR: push needs the repo clone on master with an origin remote.\n";

/** Contract "Front door": a push behind origin stops before the export. */
const BEHIND_ORIGIN = "ERROR: origin has updates; run mksync pull first.\n";

/** `front_push`'s line when the export left the repo as it was. */
const NOTHING_TO_SEND = "  Nothing to send: the repo matches this machine.\n";

/** `front_push`'s line when the question is declined. */
const KEPT_IN_REPO =
  "  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.\n";

/** The question after the changes; an empty answer or end of input opens the PR. */
const PR_QUESTION = "  Open a PR with these changes? [Y/n] ";

/** `commit`'s failed `git status`, as it prints it. */
const STATUS_FAILED = "ERROR: git status failed.\n";

/** The "Move a change" question; the answer is a line number or Enter. */
const MOVE_QUESTION =
  "Move a change? Type its number, or press Enter to go on: ";

/** The target groups, in the order "Move it to?" lists them. */
const GROUPS = [1, 2, 3, 4] as const;

/** One answer to a question: a picked value, an empty answer, or the end of
 * the input. */
type Answer<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "empty" }
  | { readonly kind: "end" };

/** The number `answer` names, when it is one of `1` to `limit`. */
function pickNumber(answer: string, limit: number): number | undefined {
  if (!/^[1-9]\d*$/.test(answer)) {
    return undefined;
  }
  const number = Number(answer);
  return number <= limit ? number : undefined;
}

/** The group `answer` names, when it is one of `1` to `4`. */
function pickGroup(answer: string): 1 | 2 | 3 | 4 | undefined {
  return GROUPS.find((group) => answer === String(group));
}

/**
 * Print `question` and read its answer; an invalid answer prints
 * `Pick 1 to <limit>.` and asks the question again.
 */
async function askNumber<T>(
  question: string,
  limit: number,
  pick: (answer: string) => T | undefined,
  readAnswer: (question: string) => Promise<string | undefined>,
  write: (text: string) => void,
): Promise<Answer<T>> {
  write(question);
  for (;;) {
    const answer = await readAnswer(question);
    if (answer === undefined) {
      return { kind: "end" };
    }
    const text = trimAnswer(answer);
    if (text === "") {
      return { kind: "empty" };
    }
    const value = pick(text);
    if (value !== undefined) {
      return { kind: "value", value };
    }
    write(`Pick 1 to ${limit}.\n`);
    write(question);
  }
}

/**
 * Ask "Move a change?" until the answer is Enter or the input ends: a line
 * number asks where the change goes, a move prints the block again and asks
 * for another change, and an empty target keeps the change where it is. A
 * moved change's error ends the loop with it.
 */
export async function askMoves(
  session: MoveSession,
  readAnswer: (question: string) => Promise<string | undefined>,
  write: (text: string) => void,
): Promise<CoreResult<void, string>> {
  for (;;) {
    const line = await askNumber(
      MOVE_QUESTION,
      session.lineCount,
      (answer) => pickNumber(answer, session.lineCount),
      readAnswer,
      write,
    );
    if (line.kind !== "value") {
      return { ok: true, value: undefined };
    }
    const current = session.groupOf(line.value);
    const target = await askNumber(
      `Move it to? ${session.targets} [${current}] `,
      GROUPS.length,
      pickGroup,
      readAnswer,
      write,
    );
    if (target.kind === "end") {
      return { ok: true, value: undefined };
    }
    if (target.kind === "empty") {
      continue;
    }
    const moved = session.move(line.value, target.value);
    if (!moved.ok) {
      return moved;
    }
    write(moved.value);
  }
}

/**
 * Run `mksync push` end to end, stopping at the export's first failure. The
 * export's output prints before the repo's changes, and the commit's output
 * follows.
 */
export async function executePush(
  input: PushInput,
  deps: PushDeps,
): Promise<Result> {
  const only = input.paths;
  if (!(await deps.cloneReady())) {
    return { code: 1, stdout: "", stderr: CLONE_ERROR };
  }

  // Contract "Front door": a repo behind origin would make the export offer
  // its own pull and stop, so stop first. A failed fetch skips the check.
  const origin = await deps.originState();
  if (origin.fetchOk && origin.behind > 0) {
    return { code: 1, stdout: "", stderr: BEHIND_ORIGIN };
  }

  const exported = await deps.runExport(only, input.yes);
  if (exported.code !== 0) {
    return exported;
  }
  if (exported.stopped) {
    return {
      code: exported.code,
      stdout: exported.stdout,
      stderr: exported.stderr,
    };
  }

  const status = await deps.statusShort();
  if (!status.ok) {
    return {
      code: 1,
      stdout: exported.stdout,
      stderr: exported.stderr + STATUS_FAILED,
    };
  }
  if (status.stdout.trim() === "") {
    return {
      code: 0,
      stdout: exported.stdout + NOTHING_TO_SEND,
      stderr: exported.stderr,
    };
  }

  deps.print({
    code: 0,
    stdout: exported.stdout + status.stdout,
    stderr: exported.stderr,
  });
  if (!input.yes && !(await deps.ask(PR_QUESTION, true))) {
    return { code: 0, stdout: KEPT_IN_REPO, stderr: "" };
  }
  return deps.runCommit(only.length > 0, input.message);
}
