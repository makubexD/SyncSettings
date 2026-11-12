/**
 * Hidden `mksync shadow` (plan step 28): the program's import check and export
 * preview next to the old engine's, compared on the status word each file got,
 * the exit code each command returned and the placeholders in each exported
 * file. Pure: the adapters run the processes and read the files.
 */

import { planCheck } from "./plan/check.ts";
import { planExport } from "./plan/export.ts";
import { planPreview } from "./plan/preview.ts";
import type { Snapshot } from "./plan/types.ts";

/**
 * One side's observable result: the import check's and the export preview's
 * status lines, kept apart so a word is compared with the same command's, the
 * files its export wrote and the exit code each command returned.
 */
export interface ShadowResult {
  readonly checkLines: readonly string[];
  readonly previewLines: readonly string[];
  readonly exported: ReadonlyMap<string, string>;
  readonly checkCode: number;
  readonly previewCode: number;
  readonly exportCode: number;
}

/** What the hidden command prints, the log text and the code it exits with. */
export interface ShadowRendering {
  readonly code: number;
  readonly stdout: string;
  readonly logText: string;
}

/**
 * The status words `tests/parity/run.sh` recognizes, in its order: longer words
 * first so CREATED and UPDATED win over CREATE and UPDATE. IN, OUT, BOTH and ?
 * are diff labels. One constant, so the pattern below cannot drift from it.
 */
export const STATUS_WORDS = [
  "ADDED",
  "UNCHANGED",
  "MODIFIED",
  "SKIPPED",
  "REMOVED",
  "ERROR",
  "CREATED",
  "UPDATED",
  "EXTRA",
  "ORPHAN",
  "DRIFT",
  "CREATE",
  "UPDATE",
  "IN",
  "OUT",
  "BOTH",
  "?",
] as const;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const PROMPT_PREFIX = /^.*\? \[[Yy]\/[Nn]\]\s*/;

const PLACEHOLDER = /<[A-Z][A-Z0-9_]*>/g;

const SAME = "shadow: same";

const DIFFERENCE_STATUS = 3;

/** A status line of either engine, as `WORD label`. */
export interface StatusEntry {
  readonly word: string;
  readonly label: string;
}

function escapeWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STATUS_LINE = new RegExp(
  `^\\s*\\[?\\s*(${STATUS_WORDS.map(escapeWord).join("|")})\\s*\\]?\\s+(\\S+)`,
);

/**
 * The status lines of a command's output, normalized exactly as the parity
 * runner does: ANSI color codes and a prompt answered from a pipe dropped,
 * notes and every other line ignored. The word list is the runner's.
 */
export function normalizeStatusLines(
  lines: readonly string[],
): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const raw of lines) {
    const line = raw.replace(ANSI, "").replace(PROMPT_PREFIX, "");
    const match = STATUS_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const word = match[1];
    const label = match[2];
    if (word === undefined || label === undefined) {
      continue;
    }
    entries.push({ word, label });
  }
  return entries;
}

/** Each label's distinct status words, in the order the output printed them. */
function wordsByLabel(
  lines: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const words = new Map<string, string[]>();
  for (const entry of normalizeStatusLines(lines)) {
    const seen = words.get(entry.label);
    if (seen === undefined) {
      words.set(entry.label, [entry.word]);
    } else if (!seen.includes(entry.word)) {
      seen.push(entry.word);
    }
  }
  return words;
}

function sameWords(
  program: readonly string[] | undefined,
  engine: readonly string[] | undefined,
): boolean {
  if (program === undefined || engine === undefined) {
    return program === engine;
  }
  return (
    program.length === engine.length &&
    program.every((word) => engine.includes(word))
  );
}

function describeWords(words: readonly string[] | undefined): string {
  return words === undefined || words.length === 0
    ? "nothing"
    : words.join(",");
}

/** The sorted, distinct placeholder tokens an exported file holds. */
function placeholders(content: string): readonly string[] {
  return [...new Set(content.match(PLACEHOLDER) ?? [])].sort();
}

function sameTokens(
  program: readonly string[],
  engine: readonly string[],
): boolean {
  return (
    program.length === engine.length &&
    program.every((token) => engine.includes(token))
  );
}

function describeTokens(tokens: readonly string[]): string {
  return tokens.length === 0 ? "none" : tokens.join(",");
}

/** One command's differing status words per label, one line each. */
function statusDifferences(
  command: "import" | "export",
  programLines: readonly string[],
  engineLines: readonly string[],
): readonly string[] {
  const programWords = wordsByLabel(programLines);
  const engineWords = wordsByLabel(engineLines);
  const labels = [
    ...programWords.keys(),
    ...[...engineWords.keys()].filter((label) => !programWords.has(label)),
  ];
  return labels.flatMap((label) => {
    const wanted = programWords.get(label);
    const got = engineWords.get(label);
    return sameWords(wanted, got)
      ? []
      : [
          `${command} ${label}: program ${describeWords(wanted)}, engine ${describeWords(got)}`,
        ];
  });
}

/** One command's differing exit code, one line, or nothing when they match. */
function codeDifference(
  command: "import" | "export" | "export run",
  program: number,
  engine: number,
): readonly string[] {
  return program === engine
    ? []
    : [`${command}: program exit ${program}, engine exit ${engine}`];
}

/**
 * Every difference between the program's and the old engine's results, one
 * line each: per command a differing exit code, per file a differing status
 * word or a file only one side lists, then per exported file a differing
 * placeholder set or a file only one side exported. Identical results mean no
 * difference and an empty list.
 *
 * When the engine's export exited non-zero its exported map is empty for a
 * reason already stated by the `export run` code line, so it is not compared.
 */
export function compareShadow(
  program: ShadowResult,
  engine: ShadowResult,
): readonly string[] {
  const differences: string[] = [
    ...codeDifference("import", program.checkCode, engine.checkCode),
    ...statusDifferences("import", program.checkLines, engine.checkLines),
    ...codeDifference("export", program.previewCode, engine.previewCode),
    ...statusDifferences("export", program.previewLines, engine.previewLines),
    ...codeDifference("export run", program.exportCode, engine.exportCode),
  ];

  if (engine.exportCode !== 0) {
    return differences;
  }

  const paths = new Set([
    ...program.exported.keys(),
    ...engine.exported.keys(),
  ]);
  for (const path of [...paths].sort()) {
    const wanted = program.exported.get(path);
    const got = engine.exported.get(path);
    if (wanted === undefined || got === undefined) {
      differences.push(
        `export ${path}: only in ${wanted === undefined ? "engine" : "program"}`,
      );
      continue;
    }
    const wantedTokens = placeholders(wanted);
    const gotTokens = placeholders(got);
    if (sameTokens(wantedTokens, gotTokens)) {
      continue;
    }
    differences.push(
      `export ${path}: placeholders differ ` +
        `(program ${describeTokens(wantedTokens)}; engine ${describeTokens(gotTokens)})`,
    );
  }

  return differences;
}

/**
 * The program's side: the import check and export preview plans and the export
 * plan's code, with the exported contents taken from the export plan's steps.
 * Pure and write-free.
 */
export function programShadow(snapshot: Snapshot): ShadowResult {
  const exported = new Map<string, string>();
  const decoder = new TextDecoder();
  const exportPlan = planExport(snapshot);
  for (const step of exportPlan.steps) {
    for (const { action } of step.actions) {
      if (action.kind === "writeRepo") {
        exported.set(action.path, decoder.decode(action.bytes));
      }
    }
  }
  const check = planCheck(snapshot);
  const preview = planPreview(snapshot);
  return {
    checkLines: check.lines,
    previewLines: preview.lines,
    exported,
    checkCode: check.code,
    previewCode: preview.code,
    exportCode: exportPlan.code,
  };
}

/**
 * Render the comparison: `shadow: same` and exit 0 with no log text, or one
 * line per difference and exit 3 with every log line prefixed by the stamp.
 */
export function renderShadow(
  differences: readonly string[],
  stamp: string,
): ShadowRendering {
  if (differences.length === 0) {
    return { code: 0, stdout: `${SAME}\n`, logText: "" };
  }
  return {
    code: DIFFERENCE_STATUS,
    stdout: `${differences.join("\n")}\n`,
    logText: differences.map((line) => `${stamp} ${line}\n`).join(""),
  };
}
