/**
 * `mksync setting list` (contract "mksync setting", `mksync setting list`):
 * load the record and the snapshot as `status` does, pick the profile, and
 * print the settings the layers above the base set. Reads only: it never
 * writes or asks.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPlan } from "../adapters/fs.ts";
import type { RunContext } from "../adapters/fs.ts";
import { pathsClean, readOrigin } from "../adapters/git.ts";
import { runLeakScan } from "../adapters/leakscan.ts";
import { buildSnapshot } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import { readStore } from "../adapters/store.ts";
import { readVisibility } from "../adapters/visibility.ts";
import type {
  ProfileShowCommand,
  RunCommand,
  SettingListCommand,
  SettingMoveCommand,
} from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { PROFILES_FOLDER, STATE_FOLDER_ROOTS } from "../core/guard.ts";
import { renderProfileShow } from "../core/machine/profile-show.ts";
import { isYes } from "../core/machine/retire.ts";
import { machineValues } from "../core/machine/scope.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { LayerName, SelectedEntry } from "../core/layers/select.ts";
import { fileLabel } from "../core/plan/changes.ts";
import { layerWords } from "../core/plan/newsettings.ts";
import { scopeFor } from "../core/plan/pick.ts";
import { renderRun } from "../core/plan/run.ts";
import { settingMoveRefusals } from "../core/plan/setting-checks.ts";
import { planSettingMove } from "../core/plan/setting-move.ts";
import {
  profileLayerFiles,
  renderSettingList,
  settingListHeader,
  settingRows,
} from "../core/plan/settings.ts";
import type {
  RepoVisibility,
  SettingListTarget,
} from "../core/plan/settings.ts";
import type {
  Action,
  StepAction,
  RepoFiles,
  RunPlan,
  Snapshot,
} from "../core/plan/types.ts";
import { failure, writePreviewTree } from "./export.ts";
import type { PreviewTailDeps, Result } from "./export.ts";
import { setupTerminal, writeLines } from "./terminal.ts";

/** What `mksync setting list` reads from the run. */
export interface SettingListInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly os: Os;
  readonly home: string;
  readonly state: string;
  readonly layers: Layers;
}

/** The snapshot is read as the import check reads it, as `status` does. */
const READ_COMMAND: RunCommand = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: true,
  resetValues: false,
  yes: false,
  only: [],
};

type Picked =
  | {
      readonly ok: true;
      readonly layers: Layers;
      readonly target: SettingListTarget;
    }
  | { readonly ok: false; readonly result: Result };

/**
 * The layers the listing reads: `--profile` swaps in that profile with no
 * machine layer; else the record's profile and machine; no record, the OS
 * layer only.
 */
function pickLayers(
  command: SettingListCommand,
  input: SettingListInput,
): Picked {
  const { layers } = input;
  if (command.profile === undefined) {
    if (layers.record === undefined || layers.machine === undefined) {
      return { ok: true, layers, target: { kind: "none" } };
    }
    return {
      ok: true,
      layers,
      target: {
        kind: "record",
        machine: layers.machine,
        profile: layers.record.profile,
      },
    };
  }
  // shortcut: only the profiles this machine holds; once the repo is private
  // `--profile` may name every profile in the repo (contract "mksync setting
  // list"), which needs the repo store's layer roots.
  const store = readStore(input.state, input.repoRoot, input.config);
  if (!store.ok) {
    return {
      ok: false,
      result: failure(store.error.message, store.error.code),
    };
  }
  const profile = store.value.profiles.find(
    (held) => held.name === command.profile,
  );
  if (profile === undefined) {
    return {
      ok: false,
      result: failure(`ERROR: unknown profile ${command.profile}`, 2),
    };
  }
  return {
    ok: true,
    layers: { location: layers.location, profile },
    target: { kind: "profile", profile: profile.name },
  };
}

async function repoVisibility(repoRoot: string): Promise<RepoVisibility> {
  const visibility = await readVisibility(
    await readOrigin(repoRoot),
    process.env,
  );
  return visibility === "private" ? "private" : "public";
}

export async function runSettingList(
  command: SettingListCommand,
  input: SettingListInput,
): Promise<Result> {
  const picked = pickLayers(command, input);
  if (!picked.ok) {
    return picked.result;
  }
  const read = await readLayerSnapshot(input, picked.layers);
  if (!read.ok) {
    return read.result;
  }
  const { selected, snapshot } = read;
  // The record's values, or `--profile`'s, on top of what the snapshot read.
  const values = {
    ...snapshot.values,
    ...machineValues(picked.layers.profile, picked.layers.record),
  };
  const rows = settingRows(selected, snapshot.repoFiles, input.os, values);
  const lines = renderSettingList(
    settingListHeader(picked.target),
    rows,
    await repoVisibility(input.repoRoot),
  );
  return { code: 0, stdout: writeLines(lines), stderr: "" };
}

/** Contract "mksync profile show": no name and no record. */
const NO_RECORD_TO_SHOW =
  "ERROR: no machine record here; run mksync setup, or name a profile.";

/** The selected entries and the files a snapshot read for `layers`, as
 * `setting list` reads them. */
async function readLayerSnapshot(
  input: SettingListInput,
  layers: Layers,
): Promise<
  | {
      readonly ok: true;
      readonly selected: readonly SelectedEntry[];
      readonly snapshot: Snapshot;
    }
  | { readonly ok: false; readonly result: Result }
> {
  const snapshot = await buildSnapshot(
    input.repoRoot,
    input.config,
    input.os,
    input.home,
    READ_COMMAND,
    process.cwd(),
    process.env,
    layers,
  );
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return {
      ok: false,
      result: failure(selected.error.message, selected.error.code),
    };
  }
  return { ok: true, selected: selected.value, snapshot };
}

/**
 * `mksync profile show [<name>]` (contract "mksync profile show"): the
 * profile from the store `profile retire` reads, this machine's record's by
 * default, and the files its layer holds in the folder `setting list
 * --profile` reads. Reads only.
 */
export async function runProfileShow(
  command: ProfileShowCommand,
  input: SettingListInput,
): Promise<Result> {
  const store = readStore(input.state, input.repoRoot, input.config);
  if (!store.ok) {
    return failure(store.error.message, store.error.code);
  }
  const name = command.target ?? store.value.record?.profile;
  if (name === undefined) {
    return failure(NO_RECORD_TO_SHOW);
  }
  const profile = store.value.profiles.find((held) => held.name === name);
  if (profile === undefined) {
    const path = join(input.state, PROFILES_FOLDER, `${name}.json`);
    return failure(`ERROR: profile ${name} not found: ${path}`);
  }
  const read = await readLayerSnapshot(input, {
    location: input.layers.location,
    profile,
  });
  if (!read.ok) {
    return read.result;
  }
  const layerFiles = profileLayerFiles(read.selected, read.snapshot.repoFiles);
  return {
    code: 0,
    stdout: writeLines(renderProfileShow(profile, layerFiles)),
    stderr: "",
  };
}

/** The plan a move starts from: nothing written yet. */
const EMPTY_PLAN: RunPlan = {
  steps: [],
  finish: [],
  lines: [],
  summary: { kind: "none" },
  code: 0,
};

/** The folder every base and OS layer file lives under. */
const DOTFILES_FOLDER = "dotfiles";
const DOTFILES_PREFIX = `${DOTFILES_FOLDER}/`;

/** A state layer's folder is its first two segments: `profiles/<p>`. */
const STATE_LAYER_DEPTH = 2;

/** The temp folder the leak scan reads, removed again on every path. */
const MOVE_SCAN_PREFIX = "mksync-setting-move-";

/** Contract "mksync setting move", Preview and question. */
const MOVE_QUESTION = "Move it? [y/N] ";
const NOTHING_MOVED = "Nothing moved.";
const DRY_RUN_LINE = "Nothing written (--dry-run).";
const MOVED = "Moved.";
const MOVED_SHARED = "Moved. mksync push sends it to the other machines.";
const NEEDS_TERMINAL = "ERROR: setting move needs a terminal or --yes";
const LEAK_REFUSED = "refused: the leak scan found the lines above.";
// shortcut: the contract names no line for a scan that can't run; this is the
// export preview's, which holds for a move too (it commits nothing).
const LEAK_CANNOT_RUN =
  "ERROR: leak scan could not run; nothing was committed.";

/** Contract "mksync setting": a usage refusal is exit 2. */
const USAGE_CODE = 2;

/** What `mksync setting move` runs outside the core; tests pass stubs. */
export interface SettingMoveDeps {
  /** True when stdin and stdout are a terminal. */
  readonly terminal: () => boolean;
  /** Write `text` (the preview and the question) and read the answer;
   * `undefined` at end of input. */
  readonly ask: (text: string) => Promise<string | undefined>;
  /** True when `path` matches the clone's `HEAD` (`git status --porcelain`). */
  readonly clean: (repoRoot: string, path: string) => Promise<boolean>;
  readonly scan: PreviewTailDeps["scan"];
  readonly now: () => Date;
}

const SETTING_MOVE_DEPS: SettingMoveDeps = {
  terminal: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: async (text) => {
    const terminal = setupTerminal();
    try {
      terminal.io.write(text);
      return await terminal.io.readLine();
    } finally {
      terminal.close();
    }
  },
  clean: (repoRoot, path) => pathsClean(repoRoot, [path]),
  scan: runLeakScan,
  // One backup folder per run, as `buildRun` stamps it.
  now: () => new Date(performance.timeOrigin),
};

/** A plan's status line as the move's preview prints it: the word and the
 * path one space apart, without the run's indent and padding. */
function statusLine(line: string): string {
  return line.trim().replace(/^(\S+)\s+/, "$1 ");
}

/** The repo paths a plan writes or removes, in plan order. */
function writtenPaths(plan: RunPlan): readonly string[] {
  return plan.steps.flatMap(({ actions }) =>
    actions.flatMap(({ action }) =>
      action.kind === "writeRepo" || action.kind === "removeRepo"
        ? [action.path]
        : [],
    ),
  );
}

function isStatePath(path: string): boolean {
  return STATE_FOLDER_ROOTS.some((root) => path.startsWith(root));
}

/**
 * A removed layer file takes the folders it empties with it, as the export's
 * removals do: up to `dotfiles/` for a base or OS file, up to the layer's
 * folder (`profiles/<p>`, `machines/<m>`) for a state file.
 */
function withPruning(item: StepAction): StepAction {
  const { action } = item;
  if (action.kind !== "removeRepo" || action.pruneUpTo !== undefined) {
    return item;
  }
  const segments = action.path.split("/");
  const stop = isStatePath(action.path)
    ? segments.slice(0, STATE_LAYER_DEPTH).join("/")
    : DOTFILES_FOLDER;
  return { ...item, action: { ...action, pruneUpTo: stop } };
}

/**
 * Contract "mksync setting move": a state file the move replaces or removes
 * keeps its `.bak`, as every state write does. A `backup` action goes before
 * each such write of a file the store holds; removals prune their folders.
 */
function withStateBackups(
  plan: RunPlan,
  snapshot: Snapshot,
  storeRoot: string,
): RunPlan {
  const steps = plan.steps.map((step) => ({
    ...step,
    actions: step.actions.flatMap((given) => {
      const item = withPruning(given);
      const { action } = item;
      if (
        (action.kind !== "writeRepo" && action.kind !== "removeRepo") ||
        !isStatePath(action.path) ||
        !snapshot.repoFiles.has(action.path)
      ) {
        return [item];
      }
      const backup: Action = {
        kind: "backup",
        path: join(storeRoot, action.path),
        repoPath: action.path,
      };
      return [{ action: backup, failure: item.failure }, item];
    }),
  }));
  return { ...plan, steps };
}

/** The repo tree with the move applied, as the leak scan's temp copy holds it. */
function movedTree(plan: RunPlan, files: RepoFiles): RepoFiles {
  const tree = new Map(files);
  for (const { actions } of plan.steps) {
    for (const { action } of actions) {
      if (action.kind === "writeRepo") {
        tree.set(action.path, action.bytes);
      } else if (action.kind === "removeRepo") {
        tree.delete(action.path);
      }
    }
  }
  return tree;
}

/**
 * Contract "mksync setting move", Checks: the leak scan on a temporary copy
 * of the clone with the move applied, as the export preview runs it. A hit
 * prints the scan's lines (the temp folder stripped) and the refusal.
 */
async function leakScanRefusal(
  repoRoot: string,
  plan: RunPlan,
  snapshot: Snapshot,
  scan: SettingMoveDeps["scan"],
): Promise<Result | undefined> {
  const tmp = await mkdtemp(join(tmpdir(), MOVE_SCAN_PREFIX));
  try {
    const paths = await writePreviewTree(
      tmp,
      movedTree(plan, snapshot.repoFiles),
    );
    const scanned = await scan(repoRoot, paths);
    if (scanned.kind === "could-not-run") {
      return failure(LEAK_CANNOT_RUN);
    }
    if (scanned.kind === "clean") {
      return undefined;
    }
    const hits = scanned.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.replaceAll(`${tmp}/`, "").replaceAll(`${tmp}\\`, ""));
    return failure(writeLines([...hits, LEAK_REFUSED]).trimEnd());
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The first `dotfiles/` path the move writes that differs from `HEAD`. */
async function dirtyRefusal(
  repoRoot: string,
  plan: RunPlan,
  clean: SettingMoveDeps["clean"],
): Promise<Result | undefined> {
  for (const path of writtenPaths(plan)) {
    if (path.startsWith(DOTFILES_PREFIX) && !(await clean(repoRoot, path))) {
      return failure(
        `refused: ${path} has changes that aren't sent; run mksync push first.`,
      );
    }
  }
  return undefined;
}

/** Run the move's writes; a failed or refused write is exit 1. */
function writeMove(
  plan: RunPlan,
  snapshot: Snapshot,
  input: SettingListInput,
  now: () => Date,
): Result | undefined {
  const context: RunContext = {
    repoRoot: input.repoRoot,
    os: input.os,
    stateFolder: input.state,
    location: input.layers.location,
    env: snapshot.env,
    now,
    pid: process.pid,
  };
  const backedUp = withStateBackups(
    plan,
    snapshot,
    dirname(input.layers.location.profilesFolder),
  );
  const outcome = runPlan(backedUp, context);
  if (outcome.refused !== undefined) {
    return failure(outcome.refused);
  }
  if (outcome.failed.size === 0) {
    return undefined;
  }
  const errors = renderRun(backedUp, outcome).lines.filter((line) =>
    line.startsWith("ERROR"),
  );
  return failure(errors.join("\n"));
}

/**
 * `mksync setting move` (contract "mksync setting", `mksync setting move`):
 * plan the move, refuse a dirty base or OS file, run the checks on text bound
 * for the base or an OS layer, then print the preview and ask (or not, under
 * `--dry-run` or `--yes`) before the writes. It never commits.
 */
export async function runSettingMove(
  command: SettingMoveCommand,
  input: SettingListInput,
  deps: SettingMoveDeps = SETTING_MOVE_DEPS,
): Promise<Result> {
  const snapshot = await buildSnapshot(
    input.repoRoot,
    input.config,
    input.os,
    input.home,
    READ_COMMAND,
    process.cwd(),
    process.env,
    input.layers,
  );
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return failure(selected.error.message, selected.error.code);
  }
  const planned = planSettingMove(
    EMPTY_PLAN,
    snapshot,
    selected.value,
    command.file,
    command.key,
    command.to,
  );
  // The entry and key refusals come first, then the record's.
  if (!planned.ok && planned.error.code === USAGE_CODE) {
    return failure(planned.error.line, planned.error.code);
  }
  const record = input.layers.record;
  if (
    record === undefined &&
    (command.to === "profile" || command.to === "machine")
  ) {
    return failure(
      `ERROR: --to ${command.to} needs a machine record; run mksync setup`,
      USAGE_CODE,
    );
  }
  if (!planned.ok) {
    return failure(planned.error.line, planned.error.code);
  }
  const profileName = input.layers.profile?.name ?? record?.profile ?? "";
  const group = (layer: LayerName): string =>
    layerWords(layer, input.os, profileName);
  const named =
    command.key === undefined ? command.file : `${command.file} ${command.key}`;
  if ("already" in planned.value) {
    return {
      code: 0,
      stdout: `${named} is already in ${group(planned.value.already)}; nothing to move.\n`,
      stderr: "",
    };
  }
  const { plan, source, text } = planned.value;
  const dirty = await dirtyRefusal(input.repoRoot, plan, deps.clean);
  if (dirty !== undefined) {
    return dirty;
  }
  // A `dir` entry is named `<file>/<name inside>`.
  const module = selected.value.find(
    ({ entry }) =>
      entry.file === command.file || command.file.startsWith(`${entry.file}/`),
  )?.entry.module;
  const label = [module, fileLabel(command.file), command.key]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const refusals = settingMoveRefusals(
    plan,
    snapshot,
    input.layers.profile,
    record?.values ?? {},
    input.home,
    input.os,
    label,
  );
  if (refusals.length > 0) {
    return failure(refusals.join("\n"));
  }
  const shared = writtenPaths(plan).some((path) =>
    path.startsWith(DOTFILES_PREFIX),
  );
  if (shared) {
    const leaked = await leakScanRefusal(
      input.repoRoot,
      plan,
      snapshot,
      deps.scan,
    );
    if (leaked !== undefined) {
      return leaked;
    }
  }
  const preview = writeLines([
    text,
    `  from ${group(source)} to ${group(command.to)}`,
    ...plan.lines.map(statusLine),
  ]);
  if (command.dryRun) {
    return { code: 0, stdout: `${preview}${DRY_RUN_LINE}\n`, stderr: "" };
  }
  let shown = preview;
  if (!command.yes) {
    if (!deps.terminal()) {
      return failure(NEEDS_TERMINAL, USAGE_CODE);
    }
    // The preview and the question are written as they are asked; the result
    // carries only what follows the answer.
    const answer = await deps.ask(`${preview}${MOVE_QUESTION}`);
    if (!isYes(answer)) {
      return { code: 1, stdout: `${NOTHING_MOVED}\n`, stderr: "" };
    }
    // The clone may have changed while the question waited.
    const dirtyNow = await dirtyRefusal(input.repoRoot, plan, deps.clean);
    if (dirtyNow !== undefined) {
      return dirtyNow;
    }
    shown = "";
  }
  const failed = writeMove(plan, snapshot, input, deps.now);
  if (failed !== undefined) {
    return { ...failed, stdout: shown };
  }
  return {
    code: 0,
    stdout: `${shown}${shared ? MOVED_SHARED : MOVED}\n`,
    stderr: "",
  };
}
