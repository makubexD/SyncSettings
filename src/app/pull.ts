/**
 * `mksync pull` (contract "Front door", the pull row and the guard): refuse
 * unsent changes, fetch and fast-forward, then the import check and, unless
 * declined, the import. Mirrors `scripts/linux/front.sh` `front_pull`, with
 * plan decision 7: the program is the same binary before and after the
 * fast-forward, so it reads the config again through the children instead of
 * re-running itself.
 *
 * Every effect is a dependency, so the flow is testable without git, a
 * terminal or a repo.
 */

import { writeLines } from "./export.ts";
import type { Result } from "./export.ts";

/** What the parsed command asks a pull to do. */
export interface PullInput {
  readonly yes: boolean;
  readonly force: boolean;
  readonly paths: readonly string[];
}

/** What a pull runs; `only` is the pull's picked paths. */
export interface PullDeps {
  /** `import --check`. */
  readonly runCheck: (only: readonly string[]) => Promise<Result>;
  /** `export --diff`. */
  readonly runDiff: (only: readonly string[]) => Promise<Result>;
  /** `import --force`. */
  readonly runImport: (only: readonly string[]) => Promise<Result>;
  /** The status's porcelain count of the sync paths. */
  readonly unsent: () => Promise<number>;
  /** `git fetch -q origin master`, then the fast-forward. */
  readonly fetchAndFastForward: () => Promise<FetchResult>;
  readonly hasSyncPoint: () => Promise<boolean>;
  /** Print `question` and read one answer; an empty answer or end of input
   * takes `defaultYes`. */
  readonly ask: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Write a result's stdout and stderr now, so a question follows them. */
  readonly print: (shown: Result) => void;
  /** The clone is on `master` with an `origin` remote. */
  readonly cloneReady: () => Promise<boolean>;
}

/** A git step's outcome; `message` is the line to print when it failed,
 * `pulled` the commits the fast-forward took. */
export interface FetchResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly pulled?: number;
}

/** `front_require_clone pull`. */
const CLONE_ERROR =
  "ERROR: pull needs the repo clone on master with an origin remote.\n";

/** `front_pull`'s unsent refusal, before any fetch. */
const UNSENT_ERROR =
  "ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.\n";

/** `front_pull`'s fetch failure, when the caller gives no message. */
const FETCH_ERROR = "ERROR: could not reach origin.";

/** `front_pull`'s count line, printed right after the fast-forward. */
function pulledLine(count: number): string {
  return `  Pulled ${count} commit(s).\n`;
}

/** A diff that can't say which side is newer. */
const COULD_NOT_TELL =
  "  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync pull --force.\n";

/** The first pull's warning and its `[y/N]` question, as `front_pull` prints
 * them. It shares a line with the warning's newline and the question. */
const NO_SYNC_QUESTION =
  "  No sync is recorded on this machine: if you changed these files here, a pull overwrites them (each keeps a .bak).\n" +
  "  Apply these changes? [y/N] ";

/** The first pull's refusal under `--yes`. */
const NO_SYNC_ERROR =
  "  ERROR: no sync is recorded on this machine, so a pull can't tell which side changed these files.\n" +
  "  Run mksync diff, then mksync push, mksync pull <path> without --yes, or mksync pull --force (each keeps a .bak).\n";

/** The apply question, after the guard passed. */
const APPLY_QUESTION = "  Apply these changes? [Y/n] ";

/** What a declined question prints, exit 0. */
const NOTHING_APPLIED = "  Nothing applied.\n";

/** A diff label line the guard stops on: `formatLine` leaves two spaces, the
 * word and one more space. */
const BLOCKED_LINE = /^ {2}(?:OUT|BOTH) /;

/** `front_pull`'s two lines for the labels that would be overwritten. */
function overwriteError(count: number): string {
  return (
    `  ERROR: ${count} file(s) changed on this machine since the last sync, and a pull would overwrite them.\n` +
    "  Run mksync push first, or mksync pull --force to overwrite them (each keeps a .bak).\n"
  );
}

/** The diff's `OUT` and `BOTH` lines, in the order it printed them. */
function blockedLines(diff: Result): readonly string[] {
  const lines = `${diff.stdout}${diff.stderr}`.split("\n");
  return lines.filter((line) => BLOCKED_LINE.test(line));
}

/** What is left to print once a question has flushed the output before it. */
const NOTHING_LEFT: Result = { code: 0, stdout: "", stderr: "" };

/** Print what the pull has shown so far, then ask: the prompt must follow it. */
function askAfter(
  deps: PullDeps,
  shown: Result,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  deps.print(shown);
  return deps.ask(question, defaultYes);
}

/** A failure the flow stops on before any child runs. */
function refusal(message: string): Result {
  return { code: 1, stdout: "", stderr: message };
}

/** A result with what the pull printed before the child ran, in front of it. */
function prefixed(prefix: string, result: Result): Result {
  return prefix === "" ? result : { ...result, stdout: prefix + result.stdout };
}

/** What a child printed, appended to what the pull printed before it. */
function append(
  before: Result,
  after: Result,
  extraStdout = "",
  extraStderr = "",
): Result {
  return {
    code: after.code,
    stdout: before.stdout + after.stdout + extraStdout,
    stderr: before.stderr + after.stderr + extraStderr,
  };
}

/**
 * Run `mksync pull` end to end, stopping at the first failure. The import
 * check's output prints as it comes; the guard asks the diff only which labels
 * block and prints those. The apply question is skipped under `--yes`.
 */
export async function executePull(
  input: PullInput,
  deps: PullDeps,
): Promise<Result> {
  const only = input.paths;

  if (!(await deps.cloneReady())) {
    return refusal(CLONE_ERROR);
  }
  if ((await deps.unsent()) > 0) {
    return refusal(UNSENT_ERROR);
  }
  const fetched = await deps.fetchAndFastForward();
  if (!fetched.ok) {
    return refusal(`${fetched.message ?? FETCH_ERROR}\n`);
  }

  // The fast-forward's count prints before the check reads the new files.
  const pulled = fetched.pulled ?? 0;
  const check = prefixed(
    pulled > 0 ? pulledLine(pulled) : "",
    await deps.runCheck(only),
  );
  if (check.code === 0) {
    // Nothing to overwrite, but a full import still records the sync point.
    if (only.length === 0) {
      return append(check, await deps.runImport([]));
    }
    return check;
  }
  if (check.code !== 3) {
    return check;
  }

  const hasSyncPoint = await deps.hasSyncPoint();

  // With no sync point every diff label would be '?', so the diff doesn't run
  // and the first pull is guarded instead.
  if (!input.force && !hasSyncPoint) {
    if (!input.yes) {
      if (!(await askAfter(deps, check, NO_SYNC_QUESTION, false))) {
        return { code: 0, stdout: NOTHING_APPLIED, stderr: "" };
      }
      return append(NOTHING_LEFT, await deps.runImport(only));
    }
    return {
      code: 1,
      stdout: check.stdout,
      stderr: check.stderr + NO_SYNC_ERROR,
    };
  }

  // A pull overwrites this machine's version of every changed file, so ask
  // the diff which side changed them first. OUT and BOTH would be lost.
  if (!input.force && hasSyncPoint) {
    const diff = await deps.runDiff(only);
    if (diff.code !== 0 && diff.code !== 3) {
      return {
        code: 1,
        stdout: check.stdout,
        stderr: check.stderr + COULD_NOT_TELL,
      };
    }
    const blocked = blockedLines(diff);
    if (blocked.length > 0) {
      return {
        code: 1,
        stdout: check.stdout + writeLines(blocked),
        stderr: check.stderr + overwriteError(blocked.length),
      };
    }
  }

  if (!input.yes) {
    if (!(await askAfter(deps, check, APPLY_QUESTION, true))) {
      return { code: 0, stdout: NOTHING_APPLIED, stderr: "" };
    }
    return append(NOTHING_LEFT, await deps.runImport(only));
  }
  return append(check, await deps.runImport(only));
}
