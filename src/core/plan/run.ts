import { formatLine } from "../status.ts";
import type {
  ExportSummary,
  ImportSummary,
  RunOutcome,
  RunPlan,
  Summary,
} from "./types.ts";

const DASHES = "  --------------------------------------------------";

const ONLY_WARNING = "  WARNING: --only matched no file.";

/** The sync point shows only its first seven characters, as bash does. */
const SYNC_POINT_SHOWN = 7;

/** The import summary, in `import.sh`'s order. */
function importSummaryLines(
  summary: ImportSummary,
  count: number,
  failed: boolean,
  backups: string | undefined,
): readonly string[] {
  const lines: string[] = ["", DASHES, "", `  ${count} file(s) applied.`, ""];
  if (backups !== undefined) {
    lines.push(`  Backups    : ${backups}`);
    lines.push("");
  }
  if (!failed && summary.syncPoint !== undefined) {
    lines.push(`  Sync point : ${summary.syncPoint.slice(0, SYNC_POINT_SHOWN)}`);
    lines.push("");
  }
  lines.push(DASHES);
  lines.push("");
  return lines;
}

/** The export summary, as `export.ts`'s `summaryLines` writes it. */
function exportSummaryLines(
  summary: ExportSummary,
  count: number,
): readonly string[] {
  const lines: string[] = ["", DASHES];
  if (count > 0) {
    lines.push("");
    lines.push(`  ${count} file(s) copied to the repo.`);
    lines.push("");
    lines.push("  Review the changes, then run  mksync push");
  } else {
    lines.push("");
    lines.push("  Repo is up to date. No changes detected.");
    if (summary.skipped > 0) {
      lines.push("");
      lines.push(
        `  Note: ${summary.skipped} file(s) skipped because they do not exist locally.`,
      );
      lines.push(
        "  If this is a new machine, run  ./import.sh  first to apply the repo settings.",
      );
    }
  }
  lines.push("");
  lines.push(DASHES);
  lines.push("");
  return lines;
}

function summaryLines(
  summary: Summary,
  count: number,
  failed: boolean,
  backups: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (summary.kind !== "none" && summary.onlyMatchedNothing) {
    lines.push(ONLY_WARNING);
  }
  switch (summary.kind) {
    case "none":
      break;
    case "import":
      lines.push(...importSummaryLines(summary, count, failed, backups));
      break;
    case "export":
      lines.push(...exportSummaryLines(summary, count));
      break;
    default: {
      const unhandled: never = summary;
      throw new Error(`Unhandled summary kind: ${String(unhandled)}`);
    }
  }
  return lines;
}

/**
 * The lines a run prints: the body with each failed step's line replaced by
 * `ERROR <label> (<reason>)` and each step's warnings before its line, then
 * the summary. The count is the counted steps that did not fail; a failed step
 * drops the sync point line, as the bash engine records nothing after an error.
 */
export function renderRun(
  plan: RunPlan,
  outcome: RunOutcome,
): { readonly lines: readonly string[]; readonly code: number } {
  const stepAtLine = new Map<number, number>();
  plan.steps.forEach((step, index) => {
    stepAtLine.set(step.line, index);
  });

  const lines: string[] = [];
  plan.lines.forEach((line, lineIndex) => {
    const stepIndex = stepAtLine.get(lineIndex);
    if (stepIndex === undefined) {
      lines.push(line);
      return;
    }
    const step = plan.steps[stepIndex];
    if (step === undefined) {
      lines.push(line);
      return;
    }
    lines.push(...(outcome.warnings.get(stepIndex) ?? []));
    const failure = outcome.failed.get(stepIndex);
    lines.push(
      failure === undefined ? line : formatLine("ERROR", step.label, failure),
    );
  });

  const failed = outcome.failed.size > 0;
  const count = plan.steps.filter(
    (step, index) => step.counted && !outcome.failed.has(index),
  ).length;
  lines.push(...summaryLines(plan.summary, count, failed, outcome.backups));
  return { lines, code: plan.code };
}
