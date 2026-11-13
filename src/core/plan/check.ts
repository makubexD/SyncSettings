import { selectEntries } from "../layers/select.ts";
import { formatLine, STATUS_WORDS } from "../status.ts";
import { planImport } from "./import.ts";
import { renderRun } from "./run.ts";
import { NO_FAILURES } from "./types.ts";
import type { Plan, RunPlan, Snapshot } from "./types.ts";

const DASHES = "  --------------------------------------------------";

const NEEDS_VALUES_NOTE = "needs values: run mksync setup";

const ERROR_HINT = "see the ERROR lines above";

/** The word width `formatLine` pads to; CREATE and UPDATE use the same layout. */
const CHECK_WORD_WIDTH = 10;

/** A value that no real file holds, so a flagged entry never reads as unchanged. */
const MISSING_SENTINEL = "\u0000mksync-needs-values:";

const MISSING_VALUE = /^missing value for (.+): add it to \.user-values\.json$/;

const STATUS_LINE = new RegExp(
  `^ {2}(${STATUS_WORDS.join("|")}) +(.+?)(?: {2}\\(.*\\))?$`,
);

interface ImportForCheck {
  readonly plan: RunPlan;
  readonly unresolved: ReadonlySet<string>;
}

interface CheckedBody {
  readonly lines: readonly string[];
  readonly changes: number;
  readonly errors: number;
}

/** CREATE and UPDATE are check words, so `formatLine`'s type does not take them. */
function checkLine(word: "CREATE" | "UPDATE", label: string): string {
  return `  ${word.padEnd(CHECK_WORD_WIDTH)} ${label}`;
}

function missingPlaceholder(line: string | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  return MISSING_VALUE.exec(line)?.[1];
}

/**
 * The import plan the check reads its decisions from. An import stops on the
 * first placeholder with no value; a check instead reports that entry as
 * `SKIPPED` and carries on, so each missing value is filled with a sentinel
 * that can never match a file until the import plan runs to completion.
 */
function importForCheck(snapshot: Snapshot): ImportForCheck {
  const values: Record<string, string> = { ...snapshot.values };
  const unresolved = new Set<string>();
  let plan = planImport({ ...snapshot, values }, []);
  for (;;) {
    if (plan.code !== 1) {
      return { plan, unresolved };
    }
    const missing = missingPlaceholder(plan.lines[0]);
    if (missing === undefined || unresolved.has(missing)) {
      return { plan, unresolved };
    }
    unresolved.add(missing);
    values[missing] = `${MISSING_SENTINEL}${missing}`;
    plan = planImport({ ...snapshot, values }, []);
  }
}

/**
 * The repo paths of the file entries holding a placeholder with no value.
 * Directory entries carry no rules on import, so they are never flagged.
 */
function labelsNeedingValues(
  snapshot: Snapshot,
  unresolved: ReadonlySet<string>,
): ReadonlySet<string> {
  const labels = new Set<string>();
  if (unresolved.size === 0) {
    return labels;
  }
  const selected = selectEntries(
    snapshot.config,
    {
      os: snapshot.os,
      ...(snapshot.profile !== undefined ? { profile: snapshot.profile } : {}),
      ...(snapshot.machine !== undefined ? { machine: snapshot.machine } : {}),
    },
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return labels;
  }
  for (const item of selected.value) {
    if (item.entry.merge === "dir" || item.entry.merge === "dconf") {
      continue;
    }
    const rules = item.entry.sanitize ?? [];
    const holds = rules.some(
      (rule) => rule.placeholder !== "" && unresolved.has(rule.placeholder),
    );
    if (!holds) {
      continue;
    }
    // Every layer a status line can name, so a layered file is skipped whole.
    if (item.layers.length === 0) {
      labels.add(`${item.writeRoot}${item.entry.file}`);
      continue;
    }
    for (const layer of item.layers) {
      labels.add(layer.repoPath);
    }
  }
  return labels;
}

/** Turn the import's status lines into the check's, keeping their order. */
function checkedBody(
  imported: readonly string[],
  needsValues: ReadonlySet<string>,
): CheckedBody {
  const lines: string[] = [];
  let changes = 0;
  let errors = 0;
  let warning: string | undefined;

  for (const line of imported) {
    if (line.startsWith("  WARNING:")) {
      warning = line;
      continue;
    }
    const match = STATUS_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const word = match[1];
    const label = match[2];
    if (word === undefined || label === undefined) {
      continue;
    }

    if (
      needsValues.has(label) &&
      (word === "CREATED" || word === "UPDATED" || word === "UNCHANGED")
    ) {
      lines.push(formatLine("SKIPPED", label, NEEDS_VALUES_NOTE));
      changes++;
      continue;
    }
    if (word === "CREATED") {
      lines.push(checkLine("CREATE", label));
      changes++;
      continue;
    }
    if (word === "UPDATED") {
      lines.push(checkLine("UPDATE", label));
      changes++;
      continue;
    }
    if (word === "ERROR") {
      errors++;
    }
    lines.push(line);
  }

  if (warning !== undefined) {
    lines.push(warning);
  }
  return { lines, changes, errors };
}

function summaryLines(body: CheckedBody): { readonly lines: readonly string[]; readonly code: number } {
  if (body.errors > 0) {
    return {
      lines: [
        "",
        `  ${body.errors} error(s); ${ERROR_HINT}.`,
        "",
        DASHES,
        "",
      ],
      code: 1,
    };
  }
  if (body.changes === 0) {
    return {
      lines: ["", "  This machine matches the repo.", "", DASHES, ""],
      code: 0,
    };
  }
  return {
    lines: [
      "",
      `  ${body.changes} file(s) would change. mksync pull overwrites them (each keeps a .bak).`,
      "  If you changed them on this machine, run mksync push first.",
      "",
      DASHES,
      "",
    ],
    code: 3,
  };
}

/**
 * The import check: what an import would change on this machine, from a
 * snapshot and nothing else. It never returns a write action.
 */
export function planCheck(snapshot: Snapshot): Plan {
  const imported = importForCheck(snapshot);
  const rendered = renderRun(imported.plan, NO_FAILURES);
  if (rendered.code !== 0) {
    return { actions: [], lines: rendered.lines, code: rendered.code };
  }

  const body = checkedBody(
    rendered.lines,
    labelsNeedingValues(snapshot, imported.unresolved),
  );
  const summary = summaryLines(body);
  return {
    actions: [],
    lines: [
      "",
      `  SyncSettings -- IMPORT CHECK (${snapshot.os})`,
      "",
      ...body.lines,
      "",
      DASHES,
      ...summary.lines,
    ],
    code: summary.code,
  };
}
