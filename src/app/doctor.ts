/**
 * `mksync doctor` (contract "Front door", the doctor table): gather what the
 * lines read and print them. Mirrors `scripts/linux/front.sh` `front_doctor`:
 * the tools on PATH, the `gh` sign-in, the origin remote, the machine record,
 * the values no layer sets, and, on Linux, package drift. Writes nothing.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { runGitResult } from "../adapters/git.ts";
import {
  driftRoot,
  readDriftIgnore,
  readInstalled,
  readPackageLists,
} from "../adapters/packages.ts";
import type { Layers } from "../adapters/snapshot.ts";
import { readText } from "../adapters/store.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { driftLines, parsePackageLists } from "../core/drift.ts";
import type { DoctorFacts, GhFact, PackageManager } from "../core/front/doctor.ts";
import { doctorLines } from "../core/front/doctor.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { SelectScope } from "../core/layers/select.ts";
import { machineScope, machineValues } from "../core/machine/scope.ts";
import { parseValuesFile } from "../core/values/file.ts";
import { resolveValues } from "../core/values/hydrate.ts";
import type { Values } from "../core/values/sanitize.ts";
import { writeLines } from "./export.ts";
import type { Result } from "./export.ts";

/** What `mksync doctor` reads from the run. */
export interface DoctorInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly os: Os;
  readonly home: string;
  readonly layers: Layers;
}

/** The managers each OS probes, in the order the first one found wins. */
const LINUX_MANAGERS: readonly PackageManager[] = ["apt-get", "dnf", "pacman"];

/** `.user-values.json` next to the config, the values with no record. */
const VALUES_FILE = ".user-values.json";

/** The `packages/linux/` folder the drift line reads, under the repo root. */
const PACKAGES_FOLDER = ["packages", "linux"] as const;

/** The word `formatLine` prints for a package that differs. */
const DRIFT_WORD = "DRIFT";

/** A DRIFT line's start: two spaces and the word. */
const DRIFT_PREFIX = `  ${DRIFT_WORD}`;

const DEFAULT_GH = "gh";

const GH_STATUS_ARGUMENTS = ["auth", "status"] as const;

/** The sign-in check's limit in seconds, as the contract fixes it. */
const GH_TIMEOUT_SECONDS = 5;

const MILLISECONDS_PER_SECOND = 1000;

/** Whether `command` is runnable as the bash doctor's `command -v` finds it. */
function onPath(command: string): boolean {
  return Bun.which(command) !== null;
}

/** Contract "Front door": the first package manager this OS has, if any. */
function packageManager(os: Os): PackageManager | undefined {
  switch (os) {
    case "macos":
      return onPath("brew") ? "brew" : undefined;
    case "windows":
      return onPath("winget") ? "winget" : undefined;
    case "linux":
      return LINUX_MANAGERS.find((manager) => onPath(manager));
    default:
      return undefined;
  }
}

/** The `gh` binary: `GH` when set and not empty, as bash's `${GH:-gh}`. */
function ghBinary(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.GH;
  return configured === undefined || configured === "" ? DEFAULT_GH : configured;
}

/**
 * What `gh auth status` says: a binary not on PATH is `missing`; a non-zero
 * exit, a spawn error or the 5-second limit is `signed-out`.
 */
async function ghFact(
  env: Readonly<Record<string, string | undefined>>,
): Promise<GhFact> {
  const binary = ghBinary(env);
  if (!onPath(binary)) {
    return "missing";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      GH_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND,
    );
  });
  try {
    const child = Bun.spawn([binary, ...GH_STATUS_ARGUMENTS], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const outcome = await Promise.race([child.exited, deadline]);
    if (outcome === "timeout") {
      // Kill and reap it; its own pipes are ignored, so nothing waits on them.
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      return "signed-out";
    }
    return outcome === 0 ? "signed-in" : "signed-out";
  } catch {
    // A binary that cannot start is not signed in.
    return "signed-out";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The repo has an `origin` remote, as `git remote get-url origin` answers. */
async function hasOrigin(repoRoot: string): Promise<boolean> {
  const remote = await runGitResult(repoRoot, ["remote", "get-url", "origin"]);
  return remote.ok;
}

/** `[[ -d path ]]`, following symlinks as bash's test does. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The drift line's count on Linux: the DRIFT lines of the report. Not Linux,
 * no `packages/linux/` folder or any read error is `undefined`, so no line.
 */
function driftCount(
  repoRoot: string,
  os: Os,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  if (os !== "linux") {
    return undefined;
  }
  const folder = join(repoRoot, ...PACKAGES_FOLDER);
  if (!isDirectory(folder)) {
    return undefined;
  }
  try {
    const lists = parsePackageLists(readPackageLists(folder));
    const installed = readInstalled({ home, root: driftRoot(env) });
    const lines = driftLines(lists, installed, readDriftIgnore(folder));
    return lines.filter((line) => line.startsWith(DRIFT_PREFIX)).length;
  } catch {
    // A folder that cannot be read is no report.
    return undefined;
  }
}

/** The layers' scope, as `scopeFor` builds it from a snapshot. */
function scopeOf(input: DoctorInput): SelectScope {
  const { profile, machine, record } = input.layers;
  return {
    os: input.os,
    ...(profile !== undefined ? { profile } : {}),
    ...(machine !== undefined ? { machine } : {}),
    ...(profile !== undefined || record !== undefined
      ? {
          modules: machineScope(input.config, profile, record, input.os).on,
        }
      : {}),
  };
}

/** The values a run hydrates with, as `buildSnapshot` chooses them. */
function valuesFor(input: DoctorInput): Values {
  return input.layers.record !== undefined
    ? machineValues(input.layers.profile, input.layers.record)
    : parseValuesFile(readText(join(input.repoRoot, VALUES_FILE)));
}

/**
 * The distinct placeholders the selected entries need that no value, default
 * or `defaultEnv` fills: the rule the import stops on, asked once per
 * placeholder by removing each missing one and asking again.
 */
function unsetValueCount(input: DoctorInput): number {
  const selected = selectEntries(
    input.config,
    scopeOf(input),
    new Set<string>(),
  );
  if (!selected.ok) {
    return 0;
  }
  const values = valuesFor(input);
  let rules = selected.value.flatMap((item) =>
    item.entry.merge === "dir" || item.entry.merge === "dconf"
      ? []
      : (item.entry.sanitize ?? []),
  );
  let count = 0;
  for (;;) {
    const resolved = resolveValues(rules, values, {}, process.env);
    if (resolved.ok) {
      return count;
    }
    const placeholder = resolved.error.placeholder;
    if (placeholder === undefined) {
      return count;
    }
    const remaining = rules.filter((rule) => rule.placeholder !== placeholder);
    // A placeholder no rule names can't be dropped; stop rather than loop.
    if (remaining.length === rules.length) {
      return count + 1;
    }
    count++;
    rules = remaining;
  }
}

/**
 * Run `mksync doctor` end to end: gather the facts and print the lines
 * `doctorLines` returns, exit 1 with any `MISSING` line. Nothing is written.
 */
export async function executeDoctor(input: DoctorInput): Promise<Result> {
  const [gh, origin] = await Promise.all([
    ghFact(process.env),
    hasOrigin(input.repoRoot),
  ]);
  const facts: DoctorFacts = {
    os: input.os,
    packageManager: packageManager(input.os),
    git: onPath("git"),
    gh,
    origin,
    record: input.layers.record !== undefined,
    unsetValues: unsetValueCount(input),
    bash: onPath("bash"),
    drift: driftCount(input.repoRoot, input.os, input.home, process.env),
  };
  const report = doctorLines(facts);
  return { code: report.code, stdout: writeLines(report.lines), stderr: "" };
}
