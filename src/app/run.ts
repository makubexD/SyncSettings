import type { RunContext } from "../adapters/fs.ts";
import { pullFastForward, readUpstreamFacts } from "../adapters/git.ts";
import { readIdentity } from "../adapters/scan.ts";
import { buildSnapshot } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import type { RunCommand } from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { checkRecord } from "../core/machine/check.ts";
import type { CheckMode, CheckResult } from "../core/machine/check.ts";
import {
  PULL_FAILED,
  pulledLine,
  upToDateAction,
} from "../core/plan/uptodate.ts";
import type { Snapshot } from "../core/plan/types.ts";
import { setupTerminal, writeLines } from "./terminal.ts";
import type { ExecuteOptions, Result } from "./export.ts";

/** What an export or import run works on, once `main` has read the repo, the
 * OS, the config and the layers. */
export interface RunEnvironment {
  readonly repoRoot: string;
  readonly state: string;
  readonly home: string;
  readonly os: Os;
  readonly config: ConfigV2;
  readonly layers: Layers;
  readonly options: ExecuteOptions | undefined;
}

/** What the up-to-date check printed before the run, and whether the run
 * stops: yes pulled (exit 0), or the pull failed (exit 1). */
export interface UpToDateRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly stop: boolean;
}

/**
 * Contract "Up-to-date check": export and import start by checking whether
 * the repo is behind `origin/master`. The question goes out at once, so it
 * shows before its answer is read; an empty answer or end of input pulls, as
 * the bash engine's `read` does. Any other answer goes on without pulling.
 */
export async function ensureUpToDate(repoRoot: string): Promise<UpToDateRun> {
  const terminal =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  const facts = await readUpstreamFacts(repoRoot);
  const action = upToDateAction({ ...facts, terminal });
  switch (action.kind) {
    case "none":
      return { stdout: "", stderr: "", code: 0, stop: false };
    case "note":
    case "warning":
      return { stdout: `${action.line}\n`, stderr: "", code: 0, stop: false };
    case "ask": {
      const terminalIo = setupTerminal();
      let answer: string | undefined;
      try {
        terminalIo.io.write(action.prompt);
        answer = await terminalIo.io.readLine();
      } finally {
        terminalIo.close();
      }
      const given = answer?.trim() ?? "";
      if (given !== "" && !/^[Yy]/.test(given)) {
        return { stdout: "", stderr: "", code: 0, stop: false };
      }
      const pulled = await pullFastForward(repoRoot);
      if (!pulled.ok) {
        return {
          stdout: "",
          stderr: `${PULL_FAILED}\n`,
          code: 1,
          stop: true,
        };
      }
      return {
        stdout: `${pulledLine(action.behind)}\n`,
        stderr: "",
        code: 0,
        stop: true,
      };
    }
    default: {
      const unhandled: never = action;
      throw new Error(`unhandled up-to-date action: ${String(unhandled)}`);
    }
  }
}

/** Decision 8: the record check a command makes. */
function checkMode(command: RunCommand): CheckMode {
  if (command.command !== "export") {
    return "pull";
  }
  return command.preview ? "preview" : "push";
}

/** What `startRun` gave back: the run stops with this result, or goes on with
 * the prefix `finish` adds and the record check's lines `endRun` merges in. */
export type RunStart =
  | { readonly kind: "stop"; readonly result: Result }
  | {
      readonly kind: "go";
      readonly finish: (result: Result) => Result;
      readonly check: CheckResult | undefined;
    };

/**
 * The checks an export or import makes before it runs: the up-to-date check,
 * then the record check. A stop comes back as a result for the caller to
 * return at once; otherwise `finish` carries the lines printed before the run.
 */
export async function startRun(
  env: RunEnvironment,
  command: RunCommand,
): Promise<RunStart> {
  // Contract "Up-to-date check": export and import start by checking the
  // repo, not check, preview or diff. The lines print before everything else
  // this run writes.
  const upToDate =
    (command.command === "export" && command.preview) ||
    (command.command === "import" && command.check)
      ? undefined
      : await ensureUpToDate(env.repoRoot);
  if (upToDate !== undefined && upToDate.stop) {
    return {
      kind: "stop",
      result: {
        code: upToDate.code,
        stdout: upToDate.stdout,
        stderr: upToDate.stderr,
        stopped: true,
      },
    };
  }
  const upToDatePrefix = upToDate?.stdout ?? "";
  const finish = (result: Result): Result =>
    upToDatePrefix === ""
      ? result
      : { ...result, stdout: upToDatePrefix + result.stdout };

  const check =
    env.layers.record === undefined
      ? undefined
      : checkRecord(
          env.layers.record,
          readIdentity(process.env, env.os),
          checkMode(command),
        );
  if (check !== undefined && check.stop) {
    return {
      kind: "stop",
      result: finish({ code: 1, stdout: "", stderr: writeLines(check.lines) }),
    };
  }
  return { kind: "go", finish, check };
}

/** What a run goes on with: the snapshot it built and the run's context. */
export interface BuiltRun {
  readonly snapshot: Snapshot;
  readonly context: RunContext;
}

/** Build the run's snapshot and the context its steps run under. */
export async function buildRun(
  env: RunEnvironment,
  command: RunCommand,
): Promise<BuiltRun> {
  const built = await buildSnapshot(
    env.repoRoot,
    env.config,
    env.os,
    env.home,
    command,
    process.cwd(),
    process.env,
    env.layers,
  );
  const snapshot: Snapshot = command.resetValues
    ? { ...built, resetValues: true }
    : built;
  const context: RunContext = {
    repoRoot: env.repoRoot,
    os: env.os,
    stateFolder: env.state,
    location: env.layers.location,
    env: snapshot.env,
    now: () => new Date(),
    pid: process.pid,
  };
  return { snapshot, context };
}

/** Merge the record check's lines into a run's stderr, after the prefix
 * `finish` adds to its stdout. */
export function endRun(
  result: Result,
  check: CheckResult | undefined,
  finish: (result: Result) => Result,
): Result {
  if (check === undefined || check.lines.length === 0) {
    return finish(result);
  }
  return finish({
    ...result,
    stderr: writeLines(check.lines) + result.stderr,
  });
}
