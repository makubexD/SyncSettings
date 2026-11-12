/**
 * The old engine's side of `mksync shadow`: run its check, preview and export
 * processes and append the shadow log. The comparison and the text live in
 * `core/shadow.ts`; this module only does the I/O.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ShadowResult } from "../core/shadow.ts";

/**
 * The host whose old-engine scripts shadow runs: Windows runs `sync.cmd`,
 * everywhere else the bash entry points. Not the contract OS, so
 * `SYNC_OS=windows` on Linux still runs the bash scripts.
 */
export type EngineHost = "windows" | "posix";

const SHADOW_LOG = "shadow.log";

const DOTFILES = "dotfiles";

/** Top-level folders the throwaway copy leaves out: the export needs none. */
const COPY_SKIPS: ReadonlySet<string> = new Set([".git", "node_modules", "dist"]);

const MISSING = "ENOENT";

/** A process killed by a signal has no exit code; report it as -1. */
const STOPPED = -1;

/** The old engine's steps shadow runs: `check`, `preview` and `export`. */
type EngineStep = "check" | "preview" | "export";

/** What one old-engine process printed. */
interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
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
  host: EngineHost,
  step: EngineStep,
  env: Readonly<Record<string, string | undefined>>,
): { readonly file: string; readonly args: readonly string[] } {
  if (host === "windows") {
    return {
      file: env.ComSpec ?? "cmd.exe",
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
  host: EngineHost,
  step: EngineStep,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ProcessOutput> {
  const command = engineCommand(host, step, env);
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

/** Whether `source` is a top-level entry of the repo that the copy leaves out. */
function isSkippedTopLevel(repoRoot: string, source: string): boolean {
  const path = relative(repoRoot, source);
  return path !== "" && !path.includes(sep) && COPY_SKIPS.has(path);
}

/**
 * Run the old engine's export against a throwaway copy of the clone, then read
 * the files it changed there. Nothing is written in the clone or in home; the
 * copy is removed whatever happens.
 */
async function exportedFromTempCopy(
  repoRoot: string,
  host: EngineHost,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly code: number | null; readonly exported: Map<string, string> }> {
  const folder = await mkdtemp(join(tmpdir(), "mksync-shadow-"));
  const copy = join(folder, "repo");
  try {
    await cp(repoRoot, copy, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !isSkippedTopLevel(repoRoot, source),
    });
    const result = await runEngineStep(copy, host, "export", env);
    return { code: result.code, exported: await changedRepoFiles(repoRoot, copy) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function exitCode(code: number | null): number {
  return code === null ? STOPPED : code;
}

/** The old engine's side: its check, preview and exported files. */
export async function engineShadow(
  repoRoot: string,
  host: EngineHost,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ShadowResult> {
  const [check, preview] = await Promise.all([
    runEngineStep(repoRoot, host, "check", env),
    runEngineStep(repoRoot, host, "preview", env),
  ]);
  const exported = await exportedFromTempCopy(repoRoot, host, env);
  return {
    checkLines: splitLines(check.stdout),
    previewLines: splitLines(preview.stdout),
    exported: exported.exported,
    checkCode: exitCode(check.code),
    previewCode: exitCode(preview.code),
    exportCode: exitCode(exported.code),
  };
}

/**
 * Append the rendered log text to `<state folder>/shadow.log`, creating the
 * state folder when it is missing. Nothing is written when the text is empty.
 */
export function appendShadowLog(stateFolder: string, logText: string): void {
  if (logText === "") {
    return;
  }
  mkdirSync(stateFolder, { recursive: true });
  appendFileSync(join(stateFolder, SHADOW_LOG), logText, "utf8");
}
