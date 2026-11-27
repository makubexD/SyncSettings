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
import { formatLine } from "../core/status.ts";
import { writeLines } from "./export.ts";
import type { DiffReport, Result } from "./export.ts";

/** What the parsed command asks a push to do. */
export interface PushInput {
  readonly yes: boolean;
  readonly force: boolean;
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

/** The files an export changed and added in the repo folder. */
export interface PushedFiles {
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
}

/** What a push runs; `only` is the push's picked paths. */
export interface PushDeps {
  /** The record's refusal (pull-only, retired, moved), before the guard. */
  readonly refusal: () => Promise<Result | undefined>;
  /** Ask the values the push's files need and save the answers, before the
   * guard (contract "Push asks"); a stop's result, or `undefined` to go on. */
  readonly askValues: () => Promise<Result | undefined>;
  readonly hasSyncPoint: () => Promise<boolean>;
  /** `export --diff`, with the conflict blocks when asked for. */
  readonly runDiff: (
    only: readonly string[],
    conflicts: boolean,
  ) => Promise<Result>;
  /** `export` with the picked paths, leaving `skip` alone; `--yes` takes the
   * new settings' suggestions. */
  readonly runExport: (
    only: readonly string[],
    yes: boolean,
    skip: readonly string[],
  ) => Promise<Result>;
  /** `git status --short` over the sync paths. */
  readonly statusShort: () => Promise<StatusResult>;
  /** A fingerprint of the record, profiles and layers in local state. */
  readonly stateStamp: () => string;
  /** Nothing the diff guard compares (`dotfiles`, `profiles`, `machines`)
   * differs from the last commit. */
  readonly guardedClean: () => Promise<boolean>;
  /** Nothing under the push paths differs from the last commit. */
  readonly pathsClean: () => Promise<boolean>;
  /** The files under the push paths that differ; `undefined` when git can't
   * tell. */
  readonly changedFiles: () => Promise<PushedFiles | undefined>;
  /** Put those files back; the error to print when it failed. */
  readonly restoreFiles: (files: PushedFiles) => Promise<string | undefined>;
  /** Print `question` and read one answer; an empty answer or end of input
   * takes `defaultYes`. */
  readonly ask: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Print `question` and read one answer, as it was typed; `undefined` at
   * end of input. */
  readonly askChoice: (question: string) => Promise<string | undefined>;
  /** `import --force --only` over `take`: the repo's version of each file,
   * keeping a `.bak`. */
  readonly runImport: (take: readonly string[]) => Promise<Result>;
  /** Write a result's stdout and stderr now, so a question follows them. */
  readonly print: (shown: Result) => void;
  /** `commit`, `--partial` when the push left files out. */
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

/** The same, when an `IN` file was left alone: the repo doesn't match. */
const NOTHING_TO_SEND_IN = "  Nothing to send.\n";

/** A diff that can't say which side is newer. */
const COULD_NOT_TELL =
  "  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync push --force.\n";

/** Contract "Front door", no sync point, interactive: the picker's header. */
const FIRST_SYNC_HEADER =
  "  No sync is recorded on this machine, so the newer side of each file is unknown. mksync preview shows each change.\n";

/** The picker's question for each file. */
const CHOICE_QUESTION =
  "  Send this machine's version (s), take the repo's (r) or skip (k)? [s/r/k] ";

/** The picker's line for any other answer, before it asks again. */
const PICK_CHOICE = "  Pick s, r or k.\n";

const NO_SYNC_POINT =
  "  WARNING: no sync is recorded on this machine, so this sends every file that differs.\n";

function leftAloneLine(count: number): string {
  return `  ${count} file(s) are newer in the repo and were left alone; run mksync pull to take them.`;
}

function bothError(count: number): string {
  return (
    `  ERROR: ${count} file(s) changed on both sides since the last sync.\n` +
    "  Merge by hand, then run mksync push --force <path>; or mksync pull --force <path> takes the repo's version (keeps a .bak).\n"
  );
}

/** An older version already in the repo folder would go out with the commit. */
const IN_BUT_DIRTY =
  "  ERROR: the repo folder has changes not sent yet, and they can hold older versions of these files; run git stash -u, then push again.\n";

/** A declined question, after the repo folder was put back. */
const NOTHING_SENT = "  Nothing sent; the repo folder is as it was.\n";

/** A declined question, when the repo folder already had changes. */
const KEPT_IN_REPO =
  "  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.\n";

/** The question after the changes; an empty answer or end of input is no. */
const PR_QUESTION = "  Open a PR with these changes? [y/N] ";

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

/** What the guard decided: stop with a result, or go on, importing `take`
 * first, leaving `skip` alone and committing with `--partial` when the push
 * sends less than everything. `nothingToSend`: no file is left to send. */
type GuardOutcome =
  | { readonly kind: "stop"; readonly result: Result }
  | {
      readonly kind: "go";
      readonly shown: string;
      readonly skip: readonly string[];
      readonly take: readonly string[];
      readonly partial: boolean;
      readonly nothingToSend?: boolean;
    };

/** A picker answer: send, take the repo's, or skip the file. */
type Choice = "s" | "r" | "k";

/** The choice `answer` names, ignoring case and spaces around it. */
function pickChoice(answer: string): Choice | undefined {
  const typed = trimAnswer(answer).toLowerCase();
  return typed === "s" || typed === "r" || typed === "k" ? typed : undefined;
}

/**
 * Ask `CHOICE_QUESTION` until the answer is `s`, `r` or `k`; any other answer
 * prints `PICK_CHOICE` first. `undefined` at end of input.
 */
async function askOneChoice(deps: PushDeps): Promise<Choice | undefined> {
  for (;;) {
    const answer = await deps.askChoice(CHOICE_QUESTION);
    if (answer === undefined) {
      return undefined;
    }
    const choice = pickChoice(answer);
    if (choice !== undefined) {
      return choice;
    }
    deps.print({ code: 0, stdout: PICK_CHOICE, stderr: "" });
  }
}

/**
 * Contract "Front door", no sync point, interactive: ask about each file the
 * diff labels `?`, in path order. `r` files are taken, `r` and `k` files left
 * out of the export; end of input is `k` for that file and every one after.
 */
async function pickFirstSync(
  report: DiffReport,
  deps: PushDeps,
): Promise<GuardOutcome> {
  const unknown = report.labels
    .filter(({ label }) => label === "?")
    .map(({ path }) => path)
    .sort();
  if (unknown.length === 0) {
    return { kind: "go", shown: "", skip: [], take: [], partial: false };
  }
  deps.print({ code: 0, stdout: FIRST_SYNC_HEADER, stderr: "" });
  const take: string[] = [];
  const skip: string[] = [];
  let ended = false;
  for (const path of unknown) {
    if (ended) {
      skip.push(path);
      continue;
    }
    const lines = report.lineCounts?.get(path) ?? 0;
    deps.print({
      code: 0,
      stdout: `\n  ${path}  ${lines} line(s) changed\n`,
      stderr: "",
    });
    const choice = await askOneChoice(deps);
    if (choice === undefined) {
      ended = true;
    }
    if (choice === "r") {
      take.push(path);
    }
    if (choice !== "s") {
      skip.push(path);
    }
  }
  // The last answer ends its line, so the next output starts on its own.
  deps.print({ code: 0, stdout: "\n", stderr: "" });
  return {
    kind: "go",
    shown: "",
    skip,
    take,
    partial: skip.length > 0,
    nothingToSend: skip.length === unknown.length,
  };
}

/** The diff's labels, when it ran to its end. */
function reportOf(diff: Result): DiffReport | undefined {
  return diff.code === 0 || diff.code === 3 ? diff.diff : undefined;
}

/**
 * Contract "Front door": what the repo changed since the last sync is never
 * sent back to its old version. Without a sync point the newer side is
 * unknown, so everything is sent after a warning.
 */
async function guardPush(
  input: PushInput,
  deps: PushDeps,
): Promise<GuardOutcome> {
  const hasSyncPoint = await deps.hasSyncPoint();
  if (!hasSyncPoint && input.yes) {
    return {
      kind: "go",
      shown: NO_SYNC_POINT,
      skip: [],
      take: [],
      partial: false,
    };
  }
  const diff = await deps.runDiff(input.paths, hasSyncPoint && !input.force);
  const report = reportOf(diff);
  if (report === undefined) {
    if (input.force) {
      // No sync point and no diff: the push sends every file that differs.
      const shown = hasSyncPoint ? "" : NO_SYNC_POINT;
      return { kind: "go", shown, skip: [], take: [], partial: true };
    }
    // A picked path that isn't synced fails the diff: its line says so.
    const reason = input.paths.length > 0 ? diff.stdout : "";
    return {
      kind: "stop",
      result: { code: 1, stdout: reason, stderr: COULD_NOT_TELL },
    };
  }
  if (!hasSyncPoint) {
    return pickFirstSync(report, deps);
  }
  const linesOf = (word: "IN" | "BOTH"): readonly string[] =>
    report.labels
      .filter(({ label }) => label === word)
      .map(({ path }) => formatLine(word, path));

  const both = linesOf("BOTH");
  if (both.length > 0 && !input.force) {
    return {
      kind: "stop",
      result: {
        code: 1,
        stdout: writeLines(both) + writeLines(report.conflictLines),
        stderr: bothError(both.length),
      },
    };
  }
  const left = linesOf("IN");
  if (left.length === 0) {
    return { kind: "go", shown: "", skip: [], take: [], partial: false };
  }
  return {
    kind: "go",
    shown: writeLines([...left, leftAloneLine(left.length)]),
    skip: report.labels
      .filter(({ label }) => label === "IN")
      .map(({ path }) => path),
    take: [],
    partial: true,
  };
}

/** The changed files the export itself wrote or removed. Any other one was
 * edited, added or ignored before, and isn't the push's to put back. */
function exportedOnly(
  changed: PushedFiles,
  repoPaths: readonly string[] | undefined,
): PushedFiles {
  const written = new Set(repoPaths ?? []);
  // Only the program writes the store's folders, some of it outside the plan.
  const isExported = (path: string): boolean =>
    written.has(path) || /^(machines|profiles)\//.test(path);
  return {
    tracked: changed.tracked.filter(isExported),
    untracked: changed.untracked.filter(isExported),
  };
}

/** Contract "Front door": a declined push leaves no trace, unless the push
 * paths had changes before it, or the export also wrote local state
 * (`changed` is then absent). */
async function declined(
  changed: PushedFiles | undefined,
  deps: PushDeps,
): Promise<Result> {
  if (changed === undefined) {
    return { code: 0, stdout: KEPT_IN_REPO, stderr: "" };
  }
  const failed = await deps.restoreFiles(changed);
  return failed === undefined
    ? { code: 0, stdout: NOTHING_SENT, stderr: "" }
    : { code: 1, stdout: KEPT_IN_REPO, stderr: failed };
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

  const refused = await deps.refusal();
  if (refused !== undefined) {
    return refused;
  }

  // Contract "Front door": a repo behind origin would make the export offer
  // its own pull and stop, so stop first. A failed fetch skips the check.
  const origin = await deps.originState();
  if (origin.fetchOk && origin.behind > 0) {
    return { code: 1, stdout: "", stderr: BEHIND_ORIGIN };
  }

  // Taken before the value questions: with the store in the repo folder,
  // saving their answers writes `profiles/` or `machines/`, which the commit
  // sends anyway.
  const cleanBeforeValues = await deps.guardedClean();

  // Contract "Push asks": the guard's diff needs every value, so the
  // questions come first. `--yes` asks nothing; the export stops instead.
  if (!input.yes) {
    const stopped = await deps.askValues();
    if (stopped !== undefined) {
      return stopped;
    }
  }

  const guard = await guardPush(input, deps);
  if (guard.kind === "stop") {
    return guard.result;
  }
  if (guard.shown !== "") {
    // The export can ask questions, so the guard's lines go out before them.
    deps.print({ code: 0, stdout: guard.shown, stderr: "" });
  }

  // The commit stages every push path, so a stale `IN` file would be sent.
  if (guard.skip.length > 0 && !cleanBeforeValues) {
    return { code: 1, stdout: "", stderr: IN_BUT_DIRTY };
  }

  // Contract "Front door": the picker's `r` files are imported before the
  // export, which leaves them out; a failed import stops the push.
  if (guard.take.length > 0) {
    const imported = await deps.runImport(guard.take);
    if (imported.code !== 0) {
      return imported;
    }
    deps.print(imported);
  }
  if (guard.nothingToSend === true) {
    return { code: 0, stdout: NOTHING_TO_SEND_IN, stderr: "" };
  }

  const stateBefore = deps.stateStamp();
  const cleanBefore = await deps.pathsClean();
  const exported = await deps.runExport(only, input.yes, guard.skip);
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
      stdout:
        exported.stdout +
        (guard.skip.length > 0 ? NOTHING_TO_SEND_IN : NOTHING_TO_SEND),
      stderr: exported.stderr,
    };
  }

  deps.print({
    code: 0,
    stdout: exported.stdout + status.stdout,
    stderr: exported.stderr,
  });
  if (input.yes) {
    return deps.runCommit(only.length > 0 || guard.partial, input.message);
  }
  // Listed before the question: a file made while it waits isn't this push's.
  // A record or layer the export moved out of local state is only in the repo
  // folder now, so putting the folder back would lose it.
  const restorable = cleanBefore && deps.stateStamp() === stateBefore;
  const listed = restorable ? await deps.changedFiles() : undefined;
  const changed =
    listed === undefined ? undefined : exportedOnly(listed, exported.repoPaths);
  if (!(await deps.ask(PR_QUESTION, false))) {
    return declined(changed, deps);
  }
  return deps.runCommit(only.length > 0 || guard.partial, input.message);
}
