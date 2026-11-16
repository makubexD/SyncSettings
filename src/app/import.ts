/**
 * `mksync import`: the up-to-date and record checks, then the import check or
 * the plan applied with the answers read from stdin. The checks and the run's
 * snapshot are shared with the export in `app/export.ts`.
 */

import { runPlan } from "../adapters/fs.ts";
import type { RunContext } from "../adapters/fs.ts";
import type { RunCommand } from "../cli/parse.ts";
import { planCheck } from "../core/plan/check.ts";
import { planImport } from "../core/plan/import.ts";
import { renderRun } from "../core/plan/run.ts";
import type { RunPlan } from "../core/plan/types.ts";
import { renderStatic, writeLines } from "./export.ts";
import type { AppliedPlan, Result } from "./export.ts";
import { buildRun, endRun, startRun } from "./run.ts";
import type { RunEnvironment } from "./run.ts";

/** Apply a plan's steps and render what the run printed, keeping the run's
 * dated backup folder. */
function applyPlanAndBackup(plan: RunPlan, context: RunContext): AppliedPlan {
  const outcome = runPlan(plan, context);
  const rendered = renderRun(plan, outcome);
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

/**
 * Read the import's prompt answers as a list, which is what `planImport`
 * takes. End of input counts as yes, so no answers means every file applies.
 */
async function readAnswers(command: RunCommand): Promise<readonly string[]> {
  if (
    command.command !== "import" ||
    command.check ||
    (command.force && !command.resetValues)
  ) {
    return [];
  }
  // shortcut: a terminal user does not see the Overwrite prompt yet. The whole
  // of stdin is read up front because the planner takes answers as a list; with
  // no piped input this waits for end of input before anything is applied.
  const text = await Bun.stdin.text();
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Run `mksync import` end to end: the checks, the answers, then the check's
 * plan or the applied one. */
export async function runImport(
  env: RunEnvironment,
  command: RunCommand,
): Promise<Result> {
  const started = await startRun(env, command);
  if (started.kind === "stop") {
    return started.result;
  }
  const answers = await readAnswers(command);
  const { snapshot, context } = await buildRun(env, command);
  const result = command.check
    ? renderStatic(planCheck(snapshot))
    : applyPlan(planImport(snapshot, answers), context);
  return endRun(result, started.check, started.finish);
}
