import pkg from "../package.json" with { type: "json" };
import { appendShadowLog, engineShadow } from "./adapters/engine.ts";
import type { EngineHost } from "./adapters/engine.ts";
import { runPlan } from "./adapters/fs.ts";
import type { RunContext } from "./adapters/fs.ts";
import { homeFolder, stateFolder } from "./adapters/paths.ts";
import { readIdentity } from "./adapters/scan.ts";
import {
  buildSnapshot,
  findRepoRoot,
  loadConfig,
  loadLayers,
  previewWorkingTree,
  V1_CONFIG,
  V2_CONFIG,
} from "./adapters/snapshot.ts";
import type { Layers } from "./adapters/snapshot.ts";
import { parseArgs, USAGE } from "./cli/parse.ts";
import type {
  MachineShowCommand,
  RunCommand,
  ShadowCommand,
} from "./cli/parse.ts";
import type { ConfigV2, Os } from "./core/config/types.ts";
import { pickOs } from "./core/layers/select.ts";
import { checkRecord } from "./core/machine/check.ts";
import type { CheckMode } from "./core/machine/check.ts";
import { machineScope } from "./core/machine/scope.ts";
import { renderMachineShow } from "./core/machine/show.ts";
import { planCheck } from "./core/plan/check.ts";
import { planExport } from "./core/plan/export.ts";
import { planImport } from "./core/plan/import.ts";
import { planPreview } from "./core/plan/preview.ts";
import { renderRun } from "./core/plan/run.ts";
import type { Plan, RunPlan } from "./core/plan/types.ts";
import { compareShadow, programShadow, renderShadow } from "./core/shadow.ts";

export { USAGE };

/** What the front prints and the code it exits with. */
export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The command whose snapshot shadow reuses: an export preview, which also
 * reads `HEAD`'s bytes. Shadow runs the same plans without printing them.
 */
const SHADOW_SNAPSHOT_COMMAND: RunCommand = {
  kind: "run",
  command: "export",
  force: false,
  preview: true,
  check: false,
  only: [],
};

/** The host whose old-engine scripts shadow runs, from the real platform. */
function hostOf(platform: string): EngineHost {
  return platform === "win32" ? "windows" : "posix";
}

/** Decision 8: the record check a command makes. */
function checkMode(command: RunCommand): CheckMode {
  if (command.command !== "export") {
    return "pull";
  }
  return command.preview ? "preview" : "push";
}

function failure(message: string, code = 1): Result {
  return { code, stdout: "", stderr: `${message}\n` };
}

function writeLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

type Resolved = Result | RunCommand | ShadowCommand | MachineShowCommand;

type ExecutableCommand = RunCommand | ShadowCommand | MachineShowCommand;

function isResolvedCommand(value: Resolved): value is ExecutableCommand {
  return "kind" in value;
}

/** The contract's no-record line, and exit 1. */
const NO_RECORD = "ERROR: no machine record here; run mksync setup.";

/**
 * Read the import's prompt answers as a list, which is what `planImport`
 * takes. End of input counts as yes, so no answers means every file applies.
 */
async function readAnswers(command: RunCommand): Promise<readonly string[]> {
  if (command.command !== "import" || command.force || command.check) {
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

/** Print a plan that writes nothing: the import check and the export preview. */
function renderStatic(plan: Plan): Result {
  return { code: plan.code, stdout: writeLines(plan.lines), stderr: "" };
}

/** Apply a plan's steps and render what the run printed. */
function applyPlan(plan: RunPlan, context: RunContext): Result {
  const rendered = renderRun(plan, runPlan(plan, context));
  return {
    code: rendered.code,
    stdout: writeLines(rendered.lines),
    stderr: "",
  };
}

/** Run the hidden shadow comparisons against the repo found from here. */
async function executeShadow(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  layers: Layers,
): Promise<Result> {
  try {
    const snapshot = await buildSnapshot(
      repoRoot,
      config,
      os,
      home,
      SHADOW_SNAPSHOT_COMMAND,
      process.cwd(),
      process.env,
      state,
      layers,
    );
    const program = programShadow(snapshot);
    const engine = await engineShadow(
      repoRoot,
      hostOf(process.platform),
      process.env,
    );
    const rendered = renderShadow(
      compareShadow(program, engine),
      new Date().toISOString(),
    );
    let stderr = "";
    try {
      appendShadowLog(state, rendered.logText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr = `WARNING: cannot write the shadow log: ${message}\n`;
    }
    return { code: rendered.code, stdout: rendered.stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`ERROR: ${message}`);
  }
}

/** Run the command against the repo found from the working folder. */
async function execute(command: ExecutableCommand): Promise<Result> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    return failure(
      `ERROR: no ${V1_CONFIG} or ${V2_CONFIG} in this folder or its parents.`,
    );
  }

  const os = pickOs(process.env.SYNC_OS, process.platform);
  if (!os.ok) {
    return failure(os.error.message, os.error.code);
  }
  const home = homeFolder(os.value, process.env);
  if (home === undefined) {
    const variable = os.value === "windows" ? "USERPROFILE" : "HOME";
    return failure(`ERROR: the home folder is not set (${variable}).`);
  }

  const config = loadConfig(repoRoot);
  if (!config.ok) {
    return failure(config.error.message, config.error.code);
  }

  const state = stateFolder(os.value, home, process.env);
  const layers = loadLayers(state, repoRoot, config.value);
  if (!layers.ok) {
    return failure(layers.error.message, layers.error.code);
  }
  if (command.kind === "shadow") {
    return executeShadow(
      repoRoot,
      config.value,
      os.value,
      home,
      state,
      layers.value,
    );
  }
  if (command.kind === "machine-show") {
    const record = layers.value.record;
    if (record === undefined) {
      return failure(NO_RECORD);
    }
    const warnings = checkRecord(
      record,
      readIdentity(process.env, os.value),
      "pull",
    );
    const lines = renderMachineShow(
      record,
      machineScope(config.value, layers.value.profile, record, os.value),
    );
    return {
      code: 0,
      stdout: writeLines(lines),
      stderr: writeLines(warnings.lines),
    };
  }

  const check =
    layers.value.record === undefined
      ? undefined
      : checkRecord(
          layers.value.record,
          readIdentity(process.env, os.value),
          checkMode(command),
        );
  if (check !== undefined && check.stop) {
    return { code: 1, stdout: "", stderr: writeLines(check.lines) };
  }

  const answers = await readAnswers(command);
  const snapshot = await buildSnapshot(
    repoRoot,
    config.value,
    os.value,
    home,
    command,
    process.cwd(),
    process.env,
    state,
    layers.value,
  );
  const context: RunContext = {
    repoRoot,
    os: os.value,
    stateFolder: state,
    now: () => new Date(),
    pid: process.pid,
  };

  let result: Result;
  if (command.command === "export") {
    result = command.preview
      ? renderStatic(
          planPreview(
            snapshot,
            previewWorkingTree(repoRoot, snapshot.repoFiles),
          ),
        )
      : applyPlan(planExport(snapshot), context);
  } else {
    result = command.check
      ? renderStatic(planCheck(snapshot))
      : applyPlan(planImport(snapshot, answers), context);
  }
  if (check === undefined || check.lines.length === 0) {
    return result;
  }
  return { ...result, stderr: writeLines(check.lines) + result.stderr };
}

/**
 * Resolve the arguments that need no repo: the version, the usage line or an
 * unknown option. A command comes back for `main` to execute.
 */
export function run(argv: readonly string[]): Resolved {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "run":
      return parsed;
    case "shadow":
      return parsed;
    case "machine-show":
      return parsed;
    case "setup":
      return failure("ERROR: setup is not wired yet", 2);
    case "version":
      return { code: 0, stdout: `mksync ${pkg.version}\n`, stderr: "" };
    case "usage":
      return { code: 2, stdout: "", stderr: `${USAGE}\n` };
    case "error":
      return { code: 1, stdout: "", stderr: `${parsed.message}\n` };
    default: {
      const unhandled: never = parsed;
      throw new Error(`unhandled command: ${String(unhandled)}`);
    }
  }
}

/** The program: argv in, its output printed, its exit code out. */
export async function main(argv: readonly string[]): Promise<number> {
  const resolved = run(argv);
  const result = isResolvedCommand(resolved)
    ? await execute(resolved)
    : resolved;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
