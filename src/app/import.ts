/**
 * `mksync import`: the up-to-date and record checks, then the import check or
 * the plan applied with the answers read from stdin. The checks and the run's
 * snapshot are shared with the export in `app/export.ts`.
 */

import { runPlan } from "../adapters/fs.ts";
import type { RunContext } from "../adapters/fs.ts";
import { stdinLines } from "../adapters/process.ts";
import { suggestions } from "../adapters/suggest.ts";
import type { SuggestionSource } from "../adapters/suggest.ts";
import type { RunCommand } from "../cli/parse.ts";
import { trimAnswer } from "../core/answer.ts";
import { planCheck } from "../core/plan/check.ts";
import {
  importOverwriteQuestions,
  importPlan,
  importAskedRules,
  importValueQuestions,
  isQuestionList,
  resolveImportValues,
} from "../core/plan/import.ts";
import { renderRun } from "../core/plan/run.ts";
import type { Action, RunPlan, Snapshot } from "../core/plan/types.ts";
import type { SanitizeRule } from "../core/config/types.ts";
import { renderStatic, writeLines } from "./export.ts";
import type { AppliedPlan, Result, SuggestValues } from "./export.ts";
import { buildRun, endRun, startRun } from "./run.ts";
import type { RunEnvironment } from "./run.ts";

/** Contract "Sync point": a write that fails prints this warning, in the bash
 * engine's form, and never changes the run's exit code. */
function syncPointWarning(failedFinish: readonly Action[]): string | undefined {
  for (const action of failedFinish) {
    if (action.kind === "writeState") {
      return `  WARNING: could not record the sync point in ${action.path}.`;
    }
  }
  return undefined;
}

/** The plan to render when the sync point was not recorded: its warning joins
 * the body, and the summary leaves out the `Sync point :` line. */
function withSyncPointWarning(plan: RunPlan, warning: string): RunPlan {
  return {
    ...plan,
    lines: [...plan.lines, warning],
    summary:
      plan.summary.kind === "import"
        ? {
            kind: "import",
            onlyMatchedNothing: plan.summary.onlyMatchedNothing,
          }
        : plan.summary,
  };
}

/** Apply a plan's steps and render what the run printed, keeping the run's
 * dated backup folder. A plan stopped by a missing value prints its line on
 * stderr, where the shell engines print it (contract "Sanitize and hydrate"). */
function applyPlanAndBackup(plan: RunPlan, context: RunContext): AppliedPlan {
  const outcome = runPlan(plan, context);
  const refused = outcome.refused;
  const warning =
    refused === undefined ? syncPointWarning(outcome.failedFinish) : undefined;
  const rendered = renderRun(
    warning === undefined ? plan : withSyncPointWarning(plan, warning),
    outcome,
  );
  const missing = plan.missing !== undefined;
  let stderr = "";
  if (refused !== undefined) {
    stderr = `${refused}\n`;
  } else if (missing) {
    stderr = writeLines(rendered.lines);
  }
  return {
    result: {
      code: refused === undefined ? rendered.code : 1,
      stdout: missing ? "" : writeLines(rendered.lines),
      stderr,
    },
    backups: outcome.backups,
  };
}

/** Apply a plan's steps and render what the run printed. */
function applyPlan(plan: RunPlan, context: RunContext): Result {
  return applyPlanAndBackup(plan, context).result;
}

/** The import's input and output, so a test can fake both: a line source and
 * where each prompt goes. */
export interface ImportIo {
  /** One input line, `undefined` at end of input. */
  readLine(): Promise<string | undefined>;
  /** Text printed before its answer is read. */
  write(text: string): void;
}

/** The real terminal: lines from `stdinLines` (lazily), prompts to stdout. */
function defaultImportIo(): ImportIo {
  let lines: AsyncIterableIterator<string> | undefined;
  return {
    readLine: async () => {
      lines ??= stdinLines();
      const next = await lines.next();
      return next.done ? undefined : next.value;
    },
    write: (text) => {
      process.stdout.write(text);
    },
  };
}

/** The overwrite prompt, as `import.sh` prints it, before one answer. */
function overwritePrompt(name: string): string {
  return `  Overwrite ${name}? [Y/n] `;
}

/**
 * Read the answers one prompt at a time and plan the run: the value questions
 * first, then one overwrite question per differing file, printing each prompt
 * before its answer is read. An empty or absent answer to a value question with
 * no default stops the run there: the remaining questions are not printed and
 * no closing newline follows. End of input answers the rest as yes.
 */
async function planWithAnswers(
  snapshot: Snapshot,
  io: ImportIo,
  suggest: SuggestValues,
): Promise<RunPlan> {
  // The sources run only when a question is about to be asked.
  const asked = importAskedRules(snapshot);
  if (asked.length > 0) {
    snapshot = { ...snapshot, suggested: await suggest(asked) };
  }
  const questions = importValueQuestions(snapshot);
  if (!isQuestionList(questions)) {
    return questions;
  }
  const valueAnswers: string[] = [];
  let stopped = false;
  for (const question of questions) {
    io.write(question.text);
    const raw = await io.readLine();
    // Enter takes the suggestion; end of input never does.
    const answer =
      raw !== undefined &&
      trimAnswer(raw) === "" &&
      question.suggestion !== undefined
        ? question.suggestion
        : (raw ?? "");
    valueAnswers.push(answer);
    if (!question.hasDefault && trimAnswer(answer) === "") {
      stopped = true;
      break;
    }
  }
  if (!stopped && questions.length > 0) {
    io.write("\n");
  }
  const resolved = resolveImportValues(snapshot, valueAnswers);
  if (!resolved.ok) {
    return resolved.plan;
  }
  const names = importOverwriteQuestions(snapshot, resolved.values);
  const overwriteAnswers: (string | undefined)[] = [];
  for (const name of names) {
    io.write(overwritePrompt(name));
    overwriteAnswers.push(await io.readLine());
  }
  return importPlan(snapshot, resolved.values, overwriteAnswers);
}

/** The suggestions under `--yes`: no source runs. */
const NO_SUGGESTIONS: SuggestValues = () => Promise.resolve({});

/** Run `mksync import` end to end: the checks, the answers, then the check's
 * plan or the applied one. */
export async function runImport(
  env: RunEnvironment,
  command: RunCommand,
  io: ImportIo = defaultImportIo(),
  suggest?: SuggestValues,
): Promise<Result> {
  const started = await startRun(env, command);
  if (started.kind === "stop") {
    return started.result;
  }
  const { snapshot, context } = await buildRun(env, command);
  const result = command.check
    ? renderStatic(planCheck(snapshot))
    : applyPlan(
        // Pull's `--yes` runs no source, so a suggestion can't fill a value unseen.
        await planWithAnswers(
          snapshot,
          io,
          command.yes
            ? NO_SUGGESTIONS
            : (suggest ??
              ((rules) => suggestions(rules, { repoRoot: env.repoRoot }))),
        ),
        context,
      );
  return endRun(result, started.check, started.finish);
}

/** The suggestion sources a run asks for, each answer with the source that
 * gave it (`suggestionSources`), injected so the tests run none. */
export type SuggestSources = (
  rules: readonly SanitizeRule[],
) => Promise<Readonly<Record<string, SuggestionSource>>>;

/** One value question an import would ask, as `setup` asks it ahead. */
export interface ImportValueAsk {
  readonly placeholder: string;
  /** The question as the import prints it, without the header. */
  readonly text: string;
  /** The suggestion in the question's brackets and the source that gave it. */
  readonly suggestion?: SuggestionSource;
}

/**
 * Contract "mksync setup", Values before the summary: the value questions
 * `command` (an import) would ask on `env.layers`, each with its suggestion
 * and the source that answered. `setup` passes the profile and record it holds
 * in memory, and the snapshot is built by the same code that pull and import
 * read from disk with, so the list is the one the import would ask once both
 * are written. The sources run only for the questions asked. A config or
 * `--only` the import can't read gives no question: the import stops with its
 * own error when it runs.
 */
export async function importValueAsks(
  env: RunEnvironment,
  command: RunCommand,
  suggest: SuggestSources,
): Promise<readonly ImportValueAsk[]> {
  const { snapshot } = await buildRun(env, command);
  const asked = importAskedRules(snapshot);
  const found = asked.length > 0 ? await suggest(asked) : {};
  const suggested = Object.fromEntries(
    Object.entries(found).map(([placeholder, { value }]) => [
      placeholder,
      value,
    ]),
  );
  const questions = importValueQuestions(
    { ...snapshot, suggested },
    { header: false },
  );
  if (!isQuestionList(questions)) {
    return [];
  }
  return questions.map((question) => {
    const source = Object.hasOwn(found, question.placeholder)
      ? found[question.placeholder]
      : undefined;
    return {
      placeholder: question.placeholder,
      text: question.text,
      ...(question.suggestion !== undefined && source !== undefined
        ? { suggestion: source }
        : {}),
    };
  });
}
