/**
 * Hidden `mksync shadow` (plan step 28): the program's import check and export
 * preview next to the old engine's, compared on the status word each file got
 * and the placeholders in each exported file. `compareShadow` is pure; the two
 * runners and the log write are injected, so the tests start no processes.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Os } from "../core/config/types.ts";
import { planCheck } from "../core/plan/check.ts";
import { planExport } from "../core/plan/export.ts";
import { planPreview } from "../core/plan/preview.ts";
import type { Snapshot } from "../core/plan/types.ts";

/**
 * One side's observable result: the import check's and the export preview's
 * status lines, kept apart so a word is compared with the same command's, and
 * the files its export wrote.
 */
export interface ShadowResult {
  readonly checkLines: readonly string[];
  readonly previewLines: readonly string[];
  readonly exported: ReadonlyMap<string, string>;
}

/** What the hidden command prints and the code it exits with. */
export interface ShadowOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The folder the old engines and this command write local state to. */
export interface ShadowOptions {
  readonly stateFolder: string;
  readonly program: () => ShadowResult;
  readonly engine: () => Promise<ShadowResult>;
  readonly now?: () => Date;
}

/**
 * The status words `tests/parity/run.sh` recognizes, in its order: longer words
 * first so CREATED and UPDATED win over CREATE and UPDATE. IN, OUT, BOTH and ?
 * are diff labels. One constant, so the pattern below cannot drift from it.
 */
const STATUS_WORDS = [
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

const SHADOW_LOG = "shadow.log";

const DOTFILES = "dotfiles";

/** Folders the throwaway copy leaves out: the engine's export needs none. */
const COPY_SKIPS: ReadonlySet<string> = new Set([".git", "node_modules", "dist"]);

const SAME = "shadow: same";

const DIFFERENCE_STATUS = 3;

const MISSING = "ENOENT";

/** A status line of either engine, as `WORD label`. */
interface StatusEntry {
  readonly word: string;
  readonly label: string;
}

/** The old engine's steps shadow runs: `check`, `preview` and `export`. */
type EngineStep = "check" | "preview" | "export";

/** What one old-engine process printed. */
interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
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
function normalizeStatusLines(
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

/**
 * Every difference between the program's and the old engine's results, one
 * line each: per file a differing status word or a file only one side lists,
 * then per exported file a differing placeholder set or a file only one side
 * exported. Identical results mean no difference and an empty list.
 */
export function compareShadow(
  program: ShadowResult,
  engine: ShadowResult,
): readonly string[] {
  const differences: string[] = [
    ...statusDifferences("import", program.checkLines, engine.checkLines),
    ...statusDifferences("export", program.previewLines, engine.previewLines),
  ];

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
 * The program's side: the import check and export preview plans, with the
 * exported contents taken from the export plan's steps. Pure and write-free.
 */
export function programShadow(snapshot: Snapshot): ShadowResult {
  const exported = new Map<string, string>();
  const decoder = new TextDecoder();
  for (const step of planExport(snapshot).steps) {
    for (const { action } of step.actions) {
      if (action.kind === "writeRepo") {
        exported.set(action.path, decoder.decode(action.bytes));
      }
    }
  }
  return {
    checkLines: planCheck(snapshot).lines,
    previewLines: planPreview(snapshot).lines,
    exported,
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === MISSING
  );
}

/** Run one process with an argument array and collect what it printed. */
function runProcess(
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
  });
}

/**
 * The old engine's command for a step, run from the repo it belongs to. On
 * Windows `sync.cmd` maps `check`, `preview` and `export` onto the PowerShell
 * entry points; elsewhere the scripts of `export.sh` and `import.sh` run.
 */
function engineCommand(
  os: Os,
  step: EngineStep,
): { readonly file: string; readonly args: readonly string[] } {
  if (os === "windows") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "sync.cmd", step],
    };
  }
  switch (step) {
    case "check":
      return { file: "./import.sh", args: ["--check"] };
    case "preview":
      return { file: "./export.sh", args: ["--preview"] };
    case "export":
      return { file: "./export.sh", args: [] };
    default: {
      const unhandled: never = step;
      throw new Error(`unhandled engine step: ${String(unhandled)}`);
    }
  }
}

function runEngineStep(
  repoRoot: string,
  os: Os,
  step: EngineStep,
): Promise<ProcessOutput> {
  const command = engineCommand(os, step);
  return runProcess(command.file, command.args, repoRoot);
}

function splitLines(output: string): readonly string[] {
  return output.split(/\r?\n/).filter((line) => line !== "");
}

/** Every file under `root`, as forward-slash paths; missing means none. */
async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function walk(folder: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(folder, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await walk(root, "");
  return files.sort();
}

async function readFileOrUndefined(
  path: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

/** The files the export changed in `copy`, keyed by repo path. */
async function changedRepoFiles(
  clone: string,
  copy: string,
): Promise<Map<string, string>> {
  const changed = new Map<string, string>();
  for (const path of await listFiles(join(copy, DOTFILES))) {
    const after = await readFile(join(copy, DOTFILES, path));
    const before = await readFileOrUndefined(join(clone, DOTFILES, path));
    if (before !== undefined && before.equals(after)) {
      continue;
    }
    changed.set(`${DOTFILES}/${path}`, after.toString("utf8"));
  }
  return changed;
}

/**
 * Run the old engine's export against a throwaway copy of the clone, then read
 * the files it changed there. Nothing is written in the clone or in home; the
 * copy is removed whatever happens.
 */
async function exportedFromTempCopy(
  repoRoot: string,
  os: Os,
): Promise<Map<string, string>> {
  const folder = await mkdtemp(join(tmpdir(), "mksync-shadow-"));
  const copy = join(folder, "repo");
  try {
    await cp(repoRoot, copy, {
      recursive: true,
      filter: (source) => !COPY_SKIPS.has(basename(source)),
    });
    await runEngineStep(copy, os, "export");
    return await changedRepoFiles(repoRoot, copy);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The old engine's side: its check, preview and exported files. */
export async function engineShadow(
  repoRoot: string,
  os: Os,
): Promise<ShadowResult> {
  const [check, preview] = await Promise.all([
    runEngineStep(repoRoot, os, "check"),
    runEngineStep(repoRoot, os, "preview"),
  ]);
  const exported = await exportedFromTempCopy(repoRoot, os);
  return {
    checkLines: splitLines(check.stdout),
    previewLines: splitLines(preview.stdout),
    exported,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Append each difference to `<state folder>/shadow.log`, prefixed with the
 * timestamp of the run, creating the state folder when it is missing. Nothing
 * is written when there is no difference.
 */
export function appendShadowLog(
  stateFolder: string,
  differences: readonly string[],
  now: () => Date = () => new Date(),
): void {
  if (differences.length === 0) {
    return;
  }
  mkdirSync(stateFolder, { recursive: true });
  const stamp = now().toISOString();
  const text = differences.map((line) => `${stamp} ${line}\n`).join("");
  appendFileSync(join(stateFolder, SHADOW_LOG), text, "utf8");
}

/**
 * Compare the two injected runners, print the result and append any difference
 * to the shadow log. `shadow: same` and exit 0, or one line per difference and
 * exit 3.
 */
export async function runShadow(
  options: ShadowOptions,
): Promise<ShadowOutcome> {
  const differences = compareShadow(options.program(), await options.engine());
  if (differences.length === 0) {
    return { code: 0, stdout: `${SAME}\n`, stderr: "" };
  }

  let stderr = "";
  try {
    appendShadowLog(options.stateFolder, differences, options.now);
  } catch (error) {
    stderr = `WARNING: cannot write the shadow log: ${messageOf(error)}\n`;
  }
  return {
    code: DIFFERENCE_STATUS,
    stdout: `${differences.join("\n")}\n`,
    stderr,
  };
}
