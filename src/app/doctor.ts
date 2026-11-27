/**
 * `mksync doctor` (contract "Front door", the doctor table): gather what the
 * lines read and print them. Mirrors `scripts/linux/front.sh` `front_doctor`:
 * the tools on PATH, the `gh` sign-in, the origin remote, the machine record,
 * the values no layer sets, and, on Linux, package drift. Writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGitResult } from "../adapters/git.ts";
import { readGitFacts } from "../adapters/gitconfig.ts";
import type { GitConfigFacts } from "../adapters/gitconfig.ts";
import { hasScanBash } from "../adapters/leakscan.ts";
import { readDriftReport } from "../adapters/packages.ts";
import { ownerToken } from "../adapters/gh.ts";
import { originOwner } from "../adapters/visibility.ts";
import { decode, run, which } from "../adapters/process.ts";
import type { Layers } from "../adapters/snapshot.ts";
import { readText } from "../adapters/store.ts";
import type { ConfigV2, ConfigV2Entry, Os } from "../core/config/types.ts";
import type {
  DoctorFacts,
  GhFact,
  GitFacts,
  GitLoginFact,
  PackageManager,
} from "../core/front/doctor.ts";
import {
  doctorLines,
  helperIsGhCredential,
  helperNamesOwner,
} from "../core/front/doctor.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { SelectScope } from "../core/layers/select.ts";
import { machineScope, machineValues } from "../core/machine/scope.ts";
import { parseValuesFile } from "../core/values/file.ts";
import { resolveValues } from "../core/values/hydrate.ts";
import { valueEnv } from "../core/values/env.ts";
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
  return which(command) !== null;
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
  return configured === undefined || configured === ""
    ? DEFAULT_GH
    : configured;
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
  const result = await run([binary, ...GH_STATUS_ARGUMENTS], {
    stdout: "ignore",
    stderr: "ignore",
    timeoutMs: GH_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND,
  });
  // A binary that cannot start or a run past the limit is not signed in.
  if (result.timedOut === true || result.notStarted === true) {
    return "signed-out";
  }
  return result.code === 0 ? "signed-in" : "signed-out";
}

/** The clone-local credential helper key the installer writes. */
const HELPER_KEY = "credential.https://github.com.helper";

/** Every `credential.https://github.com.helper` value, all scopes, in git's order. */
async function allHelpers(repoRoot: string): Promise<string[]> {
  const result = await run(
    ["git", "-C", repoRoot, "config", "--get-all", HELPER_KEY],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.code !== 0) {
    return [];
  }
  return decode(result.stdout)
    .replace(/\r?\n$/, "")
    .split(/\r?\n/);
}

/** The active account's token (`gh auth token`); undefined when gh fails. */
async function activeToken(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const result = await run(
    [ghBinary(env), "auth", "token", "--hostname", "github.com"],
    {
      stdout: "pipe",
      stderr: "ignore",
      timeoutMs: GH_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND,
    },
  );
  if (result.timedOut === true || result.notStarted === true) {
    return undefined;
  }
  if (result.code !== 0) {
    return undefined;
  }
  const token = decode(result.stdout).trim();
  return token === "" ? undefined : token;
}

/**
 * The git login facts (contract "Front door", git login): none unless gh
 * signed in and holds a token for the origin's owner. The active token is
 * asked only when the first effective helper is gh's git-credential. Nothing is written.
 */
async function gitLoginFact(
  repoRoot: string,
  gh: GhFact,
  env: Readonly<Record<string, string | undefined>>,
): Promise<GitLoginFact | undefined> {
  if (gh === "missing") {
    return undefined;
  }
  const owner = await originOwner(repoRoot);
  const token = await ownerToken(owner);
  if (owner === undefined || token === undefined) {
    return undefined;
  }
  const helpers = await allHelpers(repoRoot);
  if (helperNamesOwner(helpers, owner)) {
    return { ownerToken: token, helperNamesOwner: true };
  }
  if (!helperIsGhCredential(helpers)) {
    return { ownerToken: token, helperNamesOwner: false };
  }
  const active = await activeToken(env);
  return {
    ownerToken: token,
    helperNamesOwner: false,
    helperIsGhCredential: true,
    ...(active !== undefined ? { activeToken: active } : {}),
  };
}

/** The repo has an `origin` remote, as `git remote get-url origin` answers. */
async function hasOrigin(repoRoot: string): Promise<boolean> {
  const remote = await runGitResult(repoRoot, ["remote", "get-url", "origin"]);
  return remote.ok;
}

/**
 * The drift line's count on Linux: the DRIFT lines of the report preview
 * prints. No report (not Linux, no `packages/linux/` folder, a read error) is
 * `undefined`, so no line.
 */
function driftCount(
  repoRoot: string,
  os: Os,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const lines = readDriftReport(repoRoot, os, home, env);
  return lines?.filter((line) => line.startsWith(DRIFT_PREFIX)).length;
}

/** What the adapter read, plus the `gh` found on `PATH`. */
export interface RawGitFacts extends GitConfigFacts {
  readonly ghPath?: string;
}

/** The local file the doctor checks, as `sync-config.json` writes it. */
const LOCAL_GITCONFIG = "~/.gitconfig.local";

/** The placeholder `.gitconfig.local` points git's `gh` at. */
const GH_CLI_PLACEHOLDER = "<GH_CLI_PATH>";

/** Whether `entry` applies to `os`. */
function forOs(entry: ConfigV2Entry, os: Os): boolean {
  return entry.os === undefined || entry.os.includes(os);
}

/** `entry`'s local path on `os`. */
function localPathOn(entry: ConfigV2Entry, os: Os): string | undefined {
  return entry.localPaths?.[os] ?? entry.localPath;
}

/**
 * The `<GH_CLI_PATH>` value pull would write on `os`: the machine's value,
 * else the rule's default; undefined when no entry for `os` has the rule.
 */
function ghCliValue(
  entries: readonly ConfigV2Entry[],
  values: Values,
): string | undefined {
  const rule = entries
    .flatMap((entry) => entry.sanitize ?? [])
    .find((item) => item.placeholder === GH_CLI_PLACEHOLDER);
  if (rule === undefined) {
    return undefined;
  }
  return values[GH_CLI_PLACEHOLDER] ?? rule.default;
}

/**
 * Contract "Front door", doctor: git's view for the core lines. `config`
 * holds the entries this machine syncs; `localMissing` needs one for `os`
 * with `~/.gitconfig.local` as its local path.
 */
export function doctorGitFacts(
  config: ConfigV2,
  os: Os,
  raw: RawGitFacts,
  values: Values,
): GitFacts {
  const entries = config.entries.filter((entry) => forOs(entry, os));
  const hasLocalCopy = entries.some(
    (entry) => localPathOn(entry, os) === LOCAL_GITCONFIG,
  );
  const cliValue = ghCliValue(entries, values);
  return {
    xdgConfig: raw.xdgConfig,
    includes: raw.includes,
    localMissing: hasLocalCopy && !raw.localExists,
    ...(raw.ghPath !== undefined ? { ghPath: raw.ghPath } : {}),
    ...(cliValue !== undefined ? { ghCliValue: cliValue } : {}),
  };
}

/** The entries this machine syncs, as the import selects them; all when the
 * selection fails, so the doctor still reads git's view. */
function syncedConfig(input: DoctorInput): ConfigV2 {
  const selected = selectEntries(
    input.config,
    scopeOf(input),
    new Set<string>(),
  );
  return selected.ok
    ? { ...input.config, entries: selected.value.map((item) => item.entry) }
    : input.config;
}

/** The layers' scope, as `scopeFor` builds it from a snapshot. */
function scopeOf(input: DoctorInput): SelectScope {
  const { profile, machine, record } = input.layers;
  const recordEntries = record?.entries;
  return {
    os: input.os,
    ...(profile !== undefined ? { profile } : {}),
    ...(machine !== undefined ? { machine } : {}),
    ...(profile !== undefined || record !== undefined
      ? {
          modules: machineScope(input.config, profile, record, input.os).on,
        }
      : {}),
    ...(recordEntries !== undefined ? { machineEntries: recordEntries } : {}),
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
    const resolved = resolveValues(
      rules,
      values,
      {},
      valueEnv(process.env, input.home, input.os),
    );
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
  const [gh, origin, gitConfig] = await Promise.all([
    ghFact(process.env),
    hasOrigin(input.repoRoot),
    readGitFacts(input.home),
  ]);
  const gitLogin = await gitLoginFact(input.repoRoot, gh, process.env);
  const ghPath = which(ghBinary(process.env));
  const gitPath = which("git");
  const facts: DoctorFacts = {
    os: input.os,
    packageManager: packageManager(input.os),
    git: gitPath !== null,
    gh,
    origin,
    record: input.layers.record !== undefined,
    unsetValues: unsetValueCount(input),
    ...(gitLogin !== undefined ? { gitLogin } : {}),
    bash: hasScanBash(process.platform, gitPath, existsSync, onPath),
    drift: driftCount(input.repoRoot, input.os, input.home, process.env),
    gitFacts: doctorGitFacts(
      syncedConfig(input),
      input.os,
      { ...gitConfig, ...(ghPath !== null ? { ghPath } : {}) },
      valuesFor(input),
    ),
  };
  const report = doctorLines(facts);
  return { code: report.code, stdout: writeLines(report.lines), stderr: "" };
}
