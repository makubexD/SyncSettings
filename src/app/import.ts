/**
 * `mksync import`: the up-to-date and record checks, then the import check or
 * the plan applied with the answers read from stdin. The checks and the run's
 * snapshot are shared with the export in `app/export.ts`.
 */

import { runPlan } from "../adapters/fs.ts";
import type { RunContext } from "../adapters/fs.ts";
import { stdinLines } from "../adapters/process.ts";
import type { RunCommand } from "../cli/parse.ts";
import { planCheck } from "../core/plan/check.ts";
import {
  importOverwriteQuestions,
  importPlan,
  importValueAnswerCount,
  resolveImportValues,
} from "../core/plan/import.ts";
import { renderRun } from "../core/plan/run.ts";
import type { Action, RunPlan, Snapshot } from "../core/plan/types.ts";
import { renderStatic, writeLines } from "./export.ts";
import type { AppliedPlan, Result } from "./export.ts";
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
 * dated backup folder. */
function applyPlanAndBackup(plan: RunPlan, context: RunContext): AppliedPlan {
  const outcome = runPlan(plan, context);
  const warning = syncPointWarning(outcome.failedFinish);
  const rendered = renderRun(
    warning === undefined ? plan : withSyncPointWarning(plan, warning),
    outcome,
  );
  return {
    result: {
      code: rendered.code,
      stdout: (plan.prompt ?? "") + writeLines(rendered.lines),
      stderr: "",
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
 * Read the answers one prompt at a time and plan the run: the value answers of
 * `--reset-values` first, then one per differing file, printing each overwrite
 * prompt before its answer is read. End of input answers the rest as yes.
 */
async function planWithAnswers(
  snapshot: Snapshot,
  io: ImportIo,
): Promise<RunPlan> {
  const valueCount = importValueAnswerCount(snapshot);
  if (typeof valueCount !== "number") {
    return valueCount;
  }
  const valueAnswers: string[] = [];
  for (let i = 0; i < valueCount; i++) {
    valueAnswers.push((await io.readLine()) ?? "");
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
  return importPlan(
    snapshot,
    resolved.values,
    resolved.prompt,
    overwriteAnswers,
  );
}

/** Run `mksync import` end to end: the checks, the answers, then the check's
 * plan or the applied one. */
export async function runImport(
  env: RunEnvironment,
  command: RunCommand,
  io: ImportIo = defaultImportIo(),
): Promise<Result> {
  const started = await startRun(env, command);
  if (started.kind === "stop") {
    return started.result;
  }
  const { snapshot, context } = await buildRun(env, command);
  const result = command.check
    ? renderStatic(planCheck(snapshot))
    : applyPlan(await planWithAnswers(snapshot, io), context);
  return endRun(result, started.check, started.finish);
}
