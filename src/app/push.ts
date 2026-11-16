/**
 * `mksync push` (contract "Front door", the push row and the program note):
 * run the export, report when the repo already matches this machine, and
 * otherwise show the repo's changes, ask, and commit. Mirrors
 * `scripts/linux/front.sh` `front_push`, without "Move a change" (step 24).
 *
 * The pull-only refusal and the export's questions come from the export the
 * flow runs; this module only orders it with the question and the commit.
 * Every effect is a dependency, so the flow is testable without git, a
 * terminal or a repo.
 */

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
}

/** `front_push`'s line when the export left the repo as it was. */
const NOTHING_TO_SEND = "  Nothing to send: the repo matches this machine.\n";

/** `front_push`'s line when the question is declined. */
const KEPT_IN_REPO =
  "  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.\n";

/** The question after the changes; an empty answer or end of input opens the PR. */
const PR_QUESTION = "  Open a PR with these changes? [Y/n] ";

/** `commit`'s failed `git status`, as it prints it. */
const STATUS_FAILED = "ERROR: git status failed.\n";

/**
 * Run `mksync push` end to end, stopping at the export's first failure. The
 * export's output prints before the question, so the changes the question
 * asks about are already on the terminal; the commit's output follows.
 */
export async function executePush(
  input: PushInput,
  deps: PushDeps,
): Promise<Result> {
  const only = input.paths;
  const exported = await deps.runExport(only, input.yes);
  if (exported.code !== 0) {
    return exported;
  }

  const status = await deps.statusShort();
  if (!status.ok) {
    return { code: 1, stdout: exported.stdout, stderr: STATUS_FAILED };
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
