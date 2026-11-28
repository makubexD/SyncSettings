/**
 * `mksync setup` (contract "First run"): run the doctor, read the store and the
 * scan, run the flow (the bootstrap and value questions and the confirm
 * included), write the record and profile with `.user-values.json` and the
 * values asked, run the Ubuntu bootstrap
 * when chosen, then act on the fourth answer (decision 9). The export and
 * import the flow ends with run through the caller's `execute`, so this module
 * never imports `main.ts`.
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { join } from "node:path";
import { SymlinkRefusal } from "../adapters/atomic.ts";
import { readOrigin, readSyncPoint } from "../adapters/git.ts";
import { readOsId } from "../adapters/osname.ts";
import { run } from "../adapters/process.ts";
import { readScan } from "../adapters/scan.ts";
import { suggestionSources } from "../adapters/suggest.ts";
import type { SuggestionSource } from "../adapters/suggest.ts";
import { layersOf, loadLayers } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import {
  readLinkedFolders,
  readRepoStore,
  readStore,
  readText,
  writeProfile,
  writeRecord,
  stateLocation,
} from "../adapters/store.ts";
import { readVisibility } from "../adapters/visibility.ts";
import { executeDoctor } from "./doctor.ts";
import { exportValueAsks, failure, setupTerminal } from "./export.ts";
import {
  blockedLines,
  blockedPaths,
  diffCommand,
  diffCounts,
  pullImportCommand,
} from "./guard.ts";
import { importValueAsks } from "./import.ts";
import type { ImportValueAsk, SuggestSources } from "./import.ts";
import { isInstalledProgram } from "./update.ts";
import type { ExecuteOptions, Result, SetupTerminal } from "./export.ts";
import type { RunCommand, SetupCommand } from "../cli/parse.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, Os, SanitizeRule } from "../core/config/types.ts";
import { RECORD_ERROR_PREFIX } from "../core/machine/record.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { moveUserValues, placeValue } from "../core/machine/values.ts";
import type { ValuePlace } from "../core/machine/values.ts";
import { parseValuesFile } from "../core/values/file.ts";
import { holdsPlaceholder } from "../core/values/hydrate.ts";
import type { Values } from "../core/values/sanitize.ts";
import { runSetup } from "../wizard/setup.ts";
import type {
  ExistingAction,
  SetupDiffer,
  SetupValueAnswer,
  SetupValueChoice,
  SetupValueQuestion,
  SetupValues,
  ValueGuess,
} from "../wizard/setup.ts";

const VALUES_FILE = ".user-values.json";

/** The os-release ID whose machines offer the Ubuntu bootstrap. */
const UBUNTU = "ubuntu";

/** `bootstrap/linux.sh`, under the repo root. */
const BOOTSTRAP_SCRIPT = ["bootstrap", "linux.sh"] as const;

/** `setup --bootstrap` off Ubuntu, before doctor runs. */
const BOOTSTRAP_ONLY_UBUNTU = "ERROR: --bootstrap is Ubuntu only.";

/** `export --only`'s refusal of a path no selected entry owns (contract
 * "Picking files"). */
const NOT_SYNCED_LINE = / is not synced on this machine\.$/m;

/** After keep's export, once the changes are in the repo folder. */
const PUSHED_LINE =
  "Pushed into the repo folder; commit it with mksync push.\n";

/** `import --check`, as pull's check runs it, for question 4's differ line. */
const IMPORT_CHECK: RunCommand = pullImportCommand(true, false, []);

/** `import --force`, the import setup runs after the confirm (and the
 * bootstrap's import step runs), whose value questions setup asks first. */
const IMPORT: RunCommand = {
  kind: "run",
  command: "import",
  force: true,
  preview: false,
  check: false,
  resetValues: false,
  yes: false,
  only: [],
};

/** `export --diff`, as pull's diff runs it, for the guard block. */
const DIFF: RunCommand = diffCommand([]);

/** A check line an import would overwrite: `UPDATE`, never `CREATE`. */
const UPDATE_LINE = /^ {2}UPDATE /;

/** The check's `UPDATE` count; a `CREATE` never counts. */
function updateCount(check: Result): number {
  return `${check.stdout}${check.stderr}`
    .split("\n")
    .filter((line) => UPDATE_LINE.test(line)).length;
}

/**
 * The facts question 4 and the guard read: the import check's `UPDATE` count,
 * whether a sync point is recorded, and, with changes and a sync point, the
 * diff's counts and `OUT` / `BOTH` lines (or that it failed). Nothing prints
 * here; the wizard renders the lines.
 */
async function readDiffer(
  repoRoot: string,
  state: string,
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
): Promise<SetupDiffer> {
  const check = await execute(IMPORT_CHECK);
  const updates = updateCount(check);
  const hasSyncPoint = (await readSyncPoint(repoRoot, state)) !== undefined;
  if (check.code !== 3 || !hasSyncPoint) {
    return { updates, hasSyncPoint };
  }
  const diff = await execute(DIFF);
  // A file left out for a missing value can hold this machine's change.
  if (
    (diff.code !== 0 && diff.code !== 3) ||
    (diff.diff?.skipped.length ?? 0) > 0
  ) {
    return { updates, hasSyncPoint, diff: { ok: false } };
  }
  return {
    updates,
    hasSyncPoint,
    diff: { ok: true, ...diffCounts(diff), blocked: blockedLines(diff) },
  };
}

/** Today as `YYYY-MM-DD` in the machine's own time zone. */
function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The `.user-values.json` placeholders the value table leaves as `ask` and
 * neither the profile nor the record holds: each gets the `kept on` question
 * (contract "Values on a machine"). */
function placesToAsk(
  values: Values,
  profile: Profile,
  record: MachineRecord,
): readonly string[] {
  return Object.keys(values).filter(
    (placeholder) =>
      placeValue(placeholder) === "ask" &&
      !Object.hasOwn(profile.values, placeholder) &&
      !Object.hasOwn(record.values, placeholder),
  );
}

/**
 * Contract "Replace": each machine value of a taken-over record is asked again
 * with a fresh guess for this machine as the suggestion: its rule's `suggest`
 * sources, then the environment variable its `defaultEnv` names. A value no
 * rule can guess keeps the old machine's value as the suggestion
 * (`old machine`). shortcut: only the config's own rules are read, not a rule
 * a profile's or record's `entries` add.
 */
async function replaceQuestions(
  sources: SetupValueSources,
  choice: SetupValueChoice,
): Promise<SetupValueQuestion[]> {
  if (!choice.replaced) {
    return [];
  }
  const held = Object.entries(choice.record.values);
  const rules = sources.config.entries
    .flatMap((entry) => entry.sanitize ?? [])
    .filter((rule) =>
      held.some(([placeholder]) => placeholder === rule.placeholder),
    );
  const found = rules.length > 0 ? await sources.suggest(rules) : {};
  const env = sources.env ?? process.env;
  return held.map(([placeholder, old]) => {
    const fresh = freshGuess(placeholder, rules, found, env);
    const guess: ValueGuess = fresh ?? { value: old, source: "old machine" };
    return {
      kind: "replace",
      placeholder,
      text: `${placeholder} [${guess.value}] `,
      guess,
    };
  });
}

/** This machine's guess for a placeholder: the first rule's answered source,
 * else a usable `defaultEnv` variable; `undefined` when neither answers. */
function freshGuess(
  placeholder: string,
  rules: readonly SanitizeRule[],
  found: Readonly<Record<string, SuggestionSource>>,
  env: Readonly<Record<string, string | undefined>>,
): ValueGuess | undefined {
  if (Object.hasOwn(found, placeholder)) {
    return found[placeholder];
  }
  for (const rule of rules) {
    const value =
      rule.placeholder === placeholder && rule.defaultEnv !== undefined
        ? env[rule.defaultEnv]
        : undefined;
    if (value !== undefined && value !== "" && !holdsPlaceholder(value)) {
      return { value, source: "defaultEnv" };
    }
  }
  return undefined;
}

/** Whether keep's export runs after the confirm (`exportKeep`): not after a
 * failed diff, which stops keep, nor when the diff named no path to push. */
function keepExports(differ: SetupDiffer): boolean {
  if (differ.diff?.ok === false) {
    return false;
  }
  const paths = keepPaths(differ);
  return paths === undefined || paths.length > 0;
}

/** What `setupValues` reads besides the flow's answers. */
export interface SetupValueSources {
  readonly repoRoot: string;
  readonly state: string;
  readonly home: string;
  readonly os: Os;
  readonly config: ConfigV2;
  /** `.user-values.json`, which setup copies into the profile and record. */
  readonly fileValues: Values;
  readonly differ: SetupDiffer;
  readonly suggest: SuggestSources;
  /** The environment a rule's `defaultEnv` reads; `process.env` when absent. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Contract "mksync setup", Values before the summary: every value this run's
 * writes would ask, for the profile and record the flow holds in memory. They
 * are read as they will be written (`.user-values.json` copied in, the store
 * setup writes to), so the import after the confirm, keep's export and the
 * bootstrap's import ask none of them again. `stop` writes the record only, so
 * it asks only the `kept on` and replace questions.
 */
export async function setupValues(
  sources: SetupValueSources,
  choice: SetupValueChoice,
): Promise<SetupValues> {
  const places = placesToAsk(sources.fileValues, choice.profile, choice.record);
  const replaced = await replaceQuestions(sources, choice);
  if (choice.action === "stop") {
    return { places, questions: replaced };
  }
  const moved = moveUserValues(sources.fileValues, {});
  const profile: Profile = {
    ...choice.profile,
    values: { ...moved.profile, ...choice.profile.values },
  };
  const record: MachineRecord = {
    ...choice.record,
    values: { ...moved.machine, ...choice.record.values },
  };
  const env = {
    repoRoot: sources.repoRoot,
    state: sources.state,
    home: sources.home,
    os: sources.os,
    config: sources.config,
    layers: layersOf(stateLocation(sources.state), profile, record),
    options: undefined,
  };
  const imported = await importValueAsks(env, IMPORT, sources.suggest);
  const asked = new Set(imported.map((ask) => ask.placeholder));
  // The export's sources run only for placeholders the import doesn't ask.
  // shortcut: a source both lists name runs once per list.
  const exported =
    choice.action === "keep" && keepExports(sources.differ)
      ? await exportValueAsks(env, (rules) =>
          sources.suggest(rules.filter((rule) => !asked.has(rule.placeholder))),
        )
      : [];
  const fills = [
    ...imported,
    ...exported.filter((ask) => !asked.has(ask.placeholder)),
  ].map(fillQuestion);
  return { places, questions: [...replaced, ...fills] };
}

/** An import or export value question as setup asks it. */
function fillQuestion(ask: ImportValueAsk): SetupValueQuestion {
  return {
    kind: "fill",
    placeholder: ask.placeholder,
    text: ask.text,
    ...(ask.suggestion !== undefined ? { guess: ask.suggestion } : {}),
  };
}

/**
 * Contract "mksync setup", Values: the answers saved with the record and the
 * profile. A replace answer stays on the machine; any other goes where the
 * placeholder already lives, else where the value table puts it (an unnamed
 * one on the profile), as an import saves a value it asked.
 */
export function placeAnswers(
  answers: readonly SetupValueAnswer[],
  profile: Profile,
  record: MachineRecord,
): { readonly profile: Profile; readonly record: MachineRecord } {
  const machine: Record<string, string> = { ...record.values };
  const shared: Record<string, string> = { ...profile.values };
  for (const answer of answers) {
    const onMachine =
      answer.kind === "replace" ||
      Object.hasOwn(record.values, answer.placeholder) ||
      (!Object.hasOwn(profile.values, answer.placeholder) &&
        placeValue(answer.placeholder) === "machine");
    if (onMachine) {
      machine[answer.placeholder] = answer.value;
    } else {
      shared[answer.placeholder] = answer.value;
    }
  }
  return {
    profile: { ...profile, values: shared },
    record: { ...record, values: machine },
  };
}

/** True for the contract's bad-record line, the one `setup --replace` reads past. */
function isBadRecord(message: string): boolean {
  return message.startsWith(RECORD_ERROR_PREFIX);
}

/** `[[ -x path ]]` on a regular file, as the bash front door tests the script. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Contract "mksync setup": `bootstrap/linux.sh`, when this machine offers it
 * (Ubuntu, with an executable script); `undefined` otherwise. The flow asks
 * about it before the summary and returns the answer.
 */
function bootstrapScript(repoRoot: string, os: Os): string | undefined {
  if (os !== "linux" || readOsId(process.env) !== UBUNTU) {
    return undefined;
  }
  const script = join(repoRoot, ...BOOTSTRAP_SCRIPT);
  return isExecutableFile(script) ? script : undefined;
}

/**
 * Contract "mksync setup": runs the script the flow chose, after the record
 * and profile are written. The script owns the terminal (it may prompt for
 * sudo), so our answer reader is closed first. `MKSYNC_SETUP_EXISTING` hands it
 * the fourth answer, which its import step carries out in its usual place;
 * `MKSYNC_SETUP_EXPORTED=1` says setup already ran keep's export, so a script
 * that sees `keep` without it (an older program) still exports itself,
 * before the links, plugins and preview that need the files; setup then ends
 * with the script's exit code. `undefined` when no script runs.
 */
async function runBootstrap(
  repoRoot: string,
  os: Os,
  terminal: SetupTerminal,
  existing: ExistingAction,
  exported: boolean,
): Promise<Result | undefined> {
  const script = bootstrapScript(repoRoot, os);
  if (script === undefined) {
    return undefined;
  }
  terminal.close();
  const bootstrapped = await run([script], {
    inherit: true,
    env: {
      ...bootstrapEnv(process.env, process.execPath),
      MKSYNC_SETUP_EXISTING: existing,
      ...(exported ? { MKSYNC_SETUP_EXPORTED: "1" } : {}),
    },
  });
  return { code: bootstrapped.code, stdout: "", stderr: "" };
}

/**
 * The bootstrap's environment: this one, plus `MKSYNC_PROGRAM` naming this
 * binary when it is the installed program. On a fresh machine the installer's
 * bin folder is not on PATH yet, and the clone's launcher needs Bun or Node, so
 * the bootstrap's import and preview run this binary instead.
 */
export function bootstrapEnv(
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): Readonly<Record<string, string | undefined>> {
  if (env.MKSYNC_LAUNCHER === "1" || !isInstalledProgram(execPath)) {
    return env;
  }
  return { ...env, MKSYNC_PROGRAM: execPath };
}

/**
 * Contract "mksync setup": both first runs start with the doctor. Its output
 * goes straight to the terminal so it comes before the scan and the questions,
 * and a non-zero code stops setup before anything is asked or written.
 * `undefined` when the doctor is green.
 */
async function doctorFirst(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  layers: Layers,
): Promise<Result | undefined> {
  const doctor = await executeDoctor({ repoRoot, config, os, home, layers });
  process.stdout.write(doctor.stdout);
  process.stderr.write(doctor.stderr);
  return doctor.code === 0 ? undefined : { code: 1, stdout: "", stderr: "" };
}

/**
 * The layers the doctor reads when `setup --replace` reads past a bad local
 * record: no record, so it reports `no machine record` as the flow goes on as
 * if this machine had none. The store's location is for its writes and the
 * doctor never reads it.
 */
function noRecordLayers(state: string): Layers {
  return { location: stateLocation(state) };
}

/**
 * Contract "mksync setup": `--bootstrap` is Ubuntu only. On macOS and Windows
 * it is refused before the doctor asks or prints anything; `undefined` when
 * setup may go on.
 */
export function bootstrapRefusal(
  os: Os,
  command: SetupCommand,
): Result | undefined {
  return command.bootstrap === true && os !== "linux"
    ? failure(BOOTSTRAP_ONLY_UBUNTU)
    : undefined;
}

/**
 * Run `mksync setup` end to end: run the doctor, read the store and the scan,
 * run the flow, write the record and profile with `.user-values.json` and the
 * values the flow asked, run the Ubuntu bootstrap when the flow chose it, then
 * act on the fourth answer (decision 9). After the confirm nothing is asked.
 */
export async function executeSetup(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  command: SetupCommand,
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
): Promise<Result> {
  // Contract "mksync setup": `--bootstrap` is Ubuntu only, refused before the
  // doctor asks or prints anything.
  const refusal = bootstrapRefusal(os, command);
  if (refusal !== undefined) {
    return refusal;
  }
  const store = readStore(state, repoRoot, config);
  let own: MachineRecord | undefined;
  let localProfiles: readonly Profile[];
  if (store.ok) {
    own = store.value.record;
    localProfiles = store.value.profiles;
  } else if (
    command.replace !== undefined &&
    isBadRecord(store.error.message)
  ) {
    // Contract "The record": `setup --replace` reads past a bad local record
    // and goes on as if this machine had none. The state folder keeps its
    // profiles where the repo store's live, so read them while ignoring the
    // record; a bad profile file still stops.
    const local = readRepoStore(state, config);
    if (!local.ok) {
      return failure(local.error.message, local.error.code);
    }
    localProfiles = local.value.profiles;
  } else {
    return failure(store.error.message, store.error.code);
  }
  // Contract "mksync setup": the doctor runs after the store is read and
  // before the scan and any question. `--replace` reads past a bad record and
  // goes on as if there were none, so the doctor sees no record either.
  const layers = loadLayers(state, repoRoot, config);
  let doctorLayers: Layers;
  if (layers.ok) {
    doctorLayers = layers.value;
  } else if (
    command.replace !== undefined &&
    isBadRecord(layers.error.message)
  ) {
    doctorLayers = noRecordLayers(state);
  } else {
    return failure(layers.error.message, layers.error.code);
  }
  const stopped = await doctorFirst(repoRoot, config, os, home, doctorLayers);
  if (stopped !== undefined) {
    return stopped;
  }
  const origins = await readOrigin(repoRoot);
  const isPrivate = (await readVisibility(origins, process.env)) === "private";
  const repoStore = isPrivate ? readRepoStore(repoRoot, config) : undefined;
  if (repoStore !== undefined && !repoStore.ok) {
    return failure(repoStore.error.message, repoStore.error.code);
  }
  const profiles = repoStore?.value.profiles ?? localProfiles;
  const records = new Map<string, MachineRecord>();
  if (own !== undefined) {
    records.set(own.name, own);
  }
  for (const record of repoStore?.value.records ?? []) {
    records.set(record.name, record);
  }

  const scan = await readScan(process.env, os, home, config);
  const differ = await readDiffer(repoRoot, state, execute);
  const fileValues = parseValuesFile(readText(join(repoRoot, VALUES_FILE)));
  const valueSources: SetupValueSources = {
    repoRoot,
    state,
    home,
    os,
    config,
    fileValues,
    differ,
    // Contract "Suggested answers": `setup --yes` runs the sources too, since
    // its `Values:` block shows every guess before anything is written.
    suggest: (rules) => suggestionSources(rules, { repoRoot }),
  };
  const terminal = setupTerminal();
  const outcome = await runSetup(
    {
      scan,
      config,
      profiles,
      records: [...records.values()],
      ...(own !== undefined ? { own } : {}),
      isPrivate,
      today: localDate(new Date()),
      flags: command,
      differ,
      bootstrapOffered: bootstrapScript(repoRoot, os) !== undefined,
      linkedFolders: (profile, record) =>
        readLinkedFolders(home, os, config, profile, record),
      values: (choice) => setupValues(valueSources, choice),
    },
    terminal.io,
  );
  if (!outcome.ok) {
    terminal.close();
    if ("declined" in outcome) {
      return { code: 0, stdout: "Stopped: nothing was written.\n", stderr: "" };
    }
    return failure(outcome.message, outcome.code);
  }

  // The confirm was answered yes, so the record and the profile are written
  // with every value the flow asked before the summary, placed by the value
  // table, before keep's export, the import and the bootstrap run: none of
  // them asks again. `runBootstrap` closes the reader before the script gets
  // the terminal.
  try {
    const moved = moveUserValues(fileValues, outcome.places);
    const { profile, record } = placeAnswers(
      outcome.values,
      {
        ...outcome.profile,
        values: { ...moved.profile, ...outcome.profile.values },
      },
      {
        ...outcome.record,
        values: { ...moved.machine, ...outcome.record.values },
      },
    );
    try {
      writeProfile(state, profile);
    } catch (error) {
      if (error instanceof SymlinkRefusal) {
        return failure(error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        `ERROR: cannot write the profile ${profile.name}: ${message}`,
      );
    }
    try {
      writeRecord(state, record);
    } catch (error) {
      if (error instanceof SymlinkRefusal) {
        return failure(error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(`ERROR: cannot write the machine record: ${message}`);
    }

    // Contract "Then": only a confirm's yes reaches here, so the record and
    // profile are written. A chosen bootstrap acts on question 4 itself and
    // ends setup with its exit code; otherwise setup acts on it.
    if (outcome.bootstrap) {
      // Hotfix decision 2: the script's keep case only imports, so setup runs
      // keep's export here; its values were asked before the summary and are
      // saved. The script inherits stdout, so the export's output and
      // the Pushed line go out first; a failed export returns its result and
      // the script never runs, the record and profile staying written.
      if (outcome.action === "keep") {
        const exported = await exportKeep(execute, { terminal }, differ);
        if (exported !== undefined) {
          if (exported.code !== 0) {
            return exported;
          }
          process.stdout.write(exported.stdout);
          process.stderr.write(exported.stderr);
          process.stdout.write(PUSHED_LINE);
        }
      }
      const bootstrapped = await runBootstrap(
        repoRoot,
        os,
        terminal,
        outcome.action,
        outcome.action === "keep",
      );
      if (bootstrapped !== undefined) {
        return bootstrapped;
      }
    }
    if (outcome.action === "stop") {
      return {
        code: 0,
        stdout: "Stopped: the record is written, no file was changed.\n",
        stderr: "",
      };
    }
    return await importAfterSetup(
      outcome.action,
      execute,
      { terminal },
      differ,
    );
  } finally {
    terminal.close();
  }
}

/** Contract "Then": keep after a failed diff stops with this line. */
const KEEP_UNKNOWN =
  "ERROR: could not tell which side is newer; run mksync diff to see why, then run setup again.";

/**
 * Hotfix decision 1 (docs/plan-setup-hotfix.md): keep exports only this machine's own changes. With a diff that
 * ran, they are the paths its `OUT` and `BOTH` lines name; `undefined` means
 * export everything, as no sync point leaves the newer side unknown. A label outside `dotfiles/` isn't a repo path `export --only` takes
 * (contract "Picking files"), so it falls back to the whole export too.
 */
function keepPaths(differ: SetupDiffer): readonly string[] | undefined {
  if (differ.diff?.ok !== true) {
    return undefined;
  }
  const paths = blockedPaths(differ.diff.blocked);
  return paths.every((path) => path.startsWith("dotfiles/"))
    ? paths
    : undefined;
}

/**
 * Hotfix decision 1 (docs/plan-setup-hotfix.md): keep's export. With a diff
 * that ran and only this machine's changes, it exports those paths; with no
 * sync point, `keepPaths` says the newer side is unknown and it exports
 * everything. A failed diff stops keep with exit 1. An empty path list means there is nothing to push, so
 * `undefined` comes back and no export runs (and no `Pushed into` line prints).
 * Setup's own keep and the bootstrap's share this one rule. The diff reads an
 * entry's repo path from the sync point's tree and the export from today's, so
 * a layer added since can make `--only` refuse a path; then the whole export
 * runs, as before the hotfix, rather than failing keep.
 */
export async function exportKeep(
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
  options: ExecuteOptions,
  differ: SetupDiffer,
): Promise<Result | undefined> {
  if (differ.diff?.ok === false) {
    // A whole export would write this machine's old copy over each `IN` file.
    return failure(KEEP_UNKNOWN);
  }
  const paths = keepPaths(differ);
  if (paths !== undefined && paths.length === 0) {
    return undefined;
  }
  const exportCommand = (only: readonly string[]): RunCommand => ({
    kind: "run",
    command: "export",
    force: false,
    preview: false,
    check: false,
    resetValues: false,
    yes: false,
    only,
  });
  const exported = await execute(exportCommand(paths ?? []), options);
  if (
    paths !== undefined &&
    exported.code !== 0 &&
    NOT_SYNCED_LINE.test(`${exported.stdout}${exported.stderr}`)
  ) {
    return execute(exportCommand([]), options);
  }
  return exported;
}

/**
 * Decision 9's last move: `backup` imports at once; `keep` exports this
 * machine's own changes into the repo folder first, then imports. With a diff
 * that ran, `keep` exports only its `OUT` and `BOTH` paths, and with no such
 * path it runs only the import, printing no `Pushed into` line (hotfix decision 1).
 * Their value questions were asked before the summary and saved with the
 * record, so neither asks one; they keep setup's reader (`options.terminal`)
 * for anything else they read.
 */
async function importAfterSetup(
  action: Exclude<ExistingAction, "stop">,
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
  options: ExecuteOptions,
  differ: SetupDiffer,
): Promise<Result> {
  const importCommand = IMPORT;
  if (action === "backup") {
    return execute(importCommand, options);
  }
  const exported = await exportKeep(execute, options, differ);
  if (exported === undefined) {
    // Nothing changed on this machine since the sync point, so there is
    // nothing to send: the import alone brings the repo's `IN` files.
    return execute(importCommand, options);
  }
  if (exported.code !== 0) {
    // The local files weren't saved, so importing now would overwrite them.
    return exported;
  }
  const imported = await execute(importCommand, options);
  return {
    code: imported.code,
    stdout: exported.stdout + PUSHED_LINE + imported.stdout,
    stderr: `${exported.stderr}${imported.stderr}`,
  };
}
