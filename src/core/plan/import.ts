import { trimAnswer } from "../answer.ts";
import { same } from "../compare.ts";
import type { SanitizeRule } from "../config/types.ts";
import { jsonEqual } from "../json/value.ts";
import { selectEntries } from "../layers/select.ts";
import type { SelectedEntry } from "../layers/select.ts";
import { dconfNeedsLoad } from "../merge/dconf.ts";
import { mergeImport } from "../merge/import.ts";
import { parseJsonBytes } from "../merge/json.ts";
import { strategyFor } from "../merge/strategy.ts";
import type { LayerFile } from "../merge/types.ts";
import { formatLine } from "../status.ts";
import type { StatusWord } from "../status.ts";
import {
  ASK_HEADER,
  askValues,
  hydrate,
  inferValues,
  missingPlaceholders,
  resolveValues,
} from "../values/hydrate.ts";
import type { ValueOwner } from "../values/hydrate.ts";
import type { Values } from "../values/sanitize.ts";
import { valueOwner, valuesPrepare } from "./machine-values.ts";
import {
  basename,
  compileExcludes,
  entrySelected,
  errorPlan,
  isJsonEntry,
  joinPath,
  onlySelected,
  primaryRepoPath,
  resolvedLocal,
  resolveOnly,
  scopeFor,
  separatorFor,
} from "./pick.ts";
import type {
  Action,
  FileStep,
  ImportSummary,
  RunPlan,
  Snapshot,
  StepAction,
} from "./types.ts";

const BASE_ROOT = "dotfiles/common/";

const EXCLUDE_NOTE = "matches exclude pattern";

const REPO_MISSING_NOTE = "not found in repo";

const USER_SKIPPED_NOTE = "user skipped";

const EXTRA_NOTE = "not in repo; kept";

const SYMLINK_NOTE = "symlink";

const LOCAL_UNREADABLE = "cannot read local file";

const DCONF_NOTE = "not supported yet";

const DCONF_MISSING_NOTE = "dconf not installed";

const DCONF_HOME_NOTE = "HOME is not the login home; dconf left alone";

const DCONF_CONFIG_NOTE = "XDG_CONFIG_HOME is not ~/.config; dconf left alone";

const DCONF_FAILED_NOTE = "dconf dump failed";

const DCONF_LOAD_FAILURE = "dconf load failed";

const SYNC_POINT_FILE = "last-sync";

const BACKUP_FAILURE = "cannot create backup";

const COPY_FROM_REPO_FAILURE = "cannot copy from repo";

const WRITE_LOCAL_FAILURE = "cannot write local file";

const IMPORT_NAME_NOTE = "needs {layer} in importName";

interface State {
  readonly snapshot: Snapshot;
  readonly values: Values;
  readonly only: readonly string[];
  readonly isExcluded: (path: string) => boolean;
  readonly askOverwrite: (name: string) => boolean;
  readonly force: boolean;
  readonly steps: FileStep[];
  readonly finish: Action[];
  readonly lines: string[];
  pending: StepAction[];
  skipped: number;
  errors: number;
  userSkips: number;
  hits: number;
  readonly createdDirs: Set<string>;
}

function pushStatus(
  state: State,
  word: StatusWord,
  label: string,
  note?: string,
): number {
  state.lines.push(formatLine(word, label, note));
  state.hits++;
  if (word === "ERROR") {
    state.errors++;
  }
  if (word === "SKIPPED" && note === USER_SKIPPED_NOTE) {
    state.userSkips++;
  }
  return state.lines.length - 1;
}

/**
 * Tie the status line just pushed for `label` to the actions gathered for it.
 * A file with no actions cannot fail, so it needs no step.
 */
function recordStep(
  state: State,
  label: string,
  line: number,
  counted: boolean,
): void {
  if (state.pending.length === 0) {
    return;
  }
  state.steps.push({ label, line, counted, actions: state.pending });
  state.pending = [];
}

function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:$/.test(path);
}

/** The folder a path sits in, using this OS's own separator. */
function parentDir(path: string, separator: "/" | "\\"): string {
  const slash = path.lastIndexOf(separator);
  return slash <= 0 ? path : path.slice(0, slash);
}

/** `mkdir -p` the file's folder when the snapshot doesn't list it (decision 4). */
function ensureParentDir(state: State, path: string): void {
  const separator = separatorFor(state.snapshot.os);
  const slash = path.lastIndexOf(separator);
  if (slash <= 0) {
    return;
  }
  const parent = path.slice(0, slash);
  if (isDriveRoot(parent)) {
    return;
  }
  if (state.snapshot.localDirs.has(parent) || state.createdDirs.has(parent)) {
    return;
  }
  state.createdDirs.add(parent);
  state.pending.push({
    action: { kind: "mkdir", path: parent },
    failure: `cannot create ${parent}`,
  });
}

/** Contract "Overwrite prompt": an empty answer and end of input both mean yes.
 * `name` is what the prompt prints: the local file for an entry, the entry's
 * `path` for a dconf entry. */
function overwriteAccepted(state: State, name: string): boolean {
  if (state.force) {
    return true;
  }
  return state.askOverwrite(name);
}

function writeCreated(
  state: State,
  label: string,
  localPath: string,
  repoPath: string,
  bytes: Uint8Array,
  failure: string,
): void {
  state.pending.push({
    action: { kind: "writeLocal", path: localPath, bytes, modeFrom: repoPath },
    failure,
  });
  const line = pushStatus(state, "CREATED", label);
  recordStep(state, label, line, true);
}

function writeUpdated(
  state: State,
  label: string,
  localPath: string,
  repoPath: string,
  bytes: Uint8Array,
  failure: string,
): void {
  state.pending.push({
    action: { kind: "backup", path: localPath, repoPath },
    failure: BACKUP_FAILURE,
  });
  state.pending.push({
    action: { kind: "writeLocal", path: localPath, bytes },
    failure,
  });
  const line = pushStatus(
    state,
    "UPDATED",
    label,
    `backup saved as ${basename(localPath)}.bak`,
  );
  recordStep(state, label, line, true);
}

/** Compare a repo side with the local file, then prompt, back up and write. */
function applyBytes(
  state: State,
  label: string,
  localPath: string,
  repoPath: string,
  bytes: Uint8Array,
  sanitized: boolean,
): void {
  const local = state.snapshot.localFiles.get(localPath);
  if (local !== undefined && local.kind === "symlink") {
    const line = pushStatus(state, "SKIPPED", label, SYMLINK_NOTE);
    recordStep(state, label, line, false);
    return;
  }
  // The local file is there but can't be read: report it and write nothing.
  if (local !== undefined && local.kind === "unreadable") {
    const line = pushStatus(state, "ERROR", label, LOCAL_UNREADABLE);
    recordStep(state, label, line, false);
    return;
  }

  const failure = sanitized ? WRITE_LOCAL_FAILURE : COPY_FROM_REPO_FAILURE;
  if (local !== undefined) {
    const equal = same(bytes, local.bytes, {
      os: state.snapshot.os,
      shared: repoPath.startsWith(BASE_ROOT),
      sanitized,
    });
    if (equal) {
      const line = pushStatus(state, "UNCHANGED", label);
      recordStep(state, label, line, false);
      return;
    }
    if (!overwriteAccepted(state, localPath)) {
      const line = pushStatus(state, "SKIPPED", label, USER_SKIPPED_NOTE);
      state.skipped++;
      recordStep(state, label, line, false);
      return;
    }
    writeUpdated(state, label, localPath, repoPath, bytes, failure);
    return;
  }

  writeCreated(state, label, localPath, repoPath, bytes, failure);
}

/**
 * Each layer's bytes with its values put back, in layer order. A layer with no
 * file is left out. A missing value is unreachable after `resolveValues`; it
 * still gives the file its own `ERROR`.
 */
function hydratedLayers(
  state: State,
  selected: SelectedEntry,
  label: string,
): readonly LayerFile[] | undefined {
  const entry = selected.entry;
  const rules = entry.sanitize ?? [];
  const json = isJsonEntry(entry);
  const owner = valueOwner(state.snapshot);
  const layers: LayerFile[] = [];
  for (const layer of selected.layers) {
    const bytes = state.snapshot.repoFiles.get(layer.repoPath);
    if (bytes === undefined) {
      continue;
    }
    if (rules.length === 0) {
      layers.push({ repoPath: layer.repoPath, bytes });
      continue;
    }
    const hydrated = hydrate(bytes, rules, state.values, {
      json,
      ...(owner !== undefined ? { owner } : {}),
    });
    if (!hydrated.ok) {
      const line = pushStatus(state, "ERROR", label, hydrated.error.message);
      recordStep(state, label, line, false);
      return undefined;
    }
    layers.push({ repoPath: layer.repoPath, bytes: hydrated.value });
  }
  return layers;
}

/** The merged bytes of an entry, or its contract `ERROR` note. */
function mergedBytes(
  state: State,
  selected: SelectedEntry,
  layers: readonly LayerFile[],
  localPath: string,
  eol: "\n" | "\r\n",
):
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly note: string } {
  const entry = selected.entry;
  const strategy = strategyFor(entry.merge);
  if (strategy === undefined) {
    throw new Error(`merge type ${entry.merge} has no strategy`);
  }
  const local = state.snapshot.localFiles.get(localPath);
  const merged = strategy.merge(layers, {
    eol,
    ...(local !== undefined && local.kind === "file"
      ? { local: local.bytes }
      : {}),
    localOnlyKeys: entry.localOnlyKeys ?? [],
  });
  return merged.ok
    ? { ok: true, bytes: merged.value }
    : { ok: false, note: merged.error };
}

/** Whether two files hold the same JSON value, whatever their layout. */
function sameJson(left: Uint8Array, right: Uint8Array): boolean {
  const leftValue = parseJsonBytes(left);
  const rightValue = parseJsonBytes(right);
  return (
    leftValue !== undefined &&
    rightValue !== undefined &&
    jsonEqual(leftValue, rightValue)
  );
}

/** Write the local file, then each later layer's file beside it, each with its
 * own status line (contract "Layers (program only)", import entries). */
function planImportFile(
  state: State,
  selected: SelectedEntry,
  layers: readonly LayerFile[],
  localPath: string,
  sanitized: boolean,
  eol: "\n" | "\r\n",
): void {
  const entry = selected.entry;
  // The local file is the base text plus the engine's block, so it reads and
  // writes the base layer; each side file is the whole of its own layer.
  const label = selected.layers[0]?.repoPath ?? primaryRepoPath(selected);
  const importName = entry.importName;
  if (importName === undefined) {
    const line = pushStatus(state, "ERROR", label, IMPORT_NAME_NOTE);
    recordStep(state, label, line, false);
    return;
  }
  const hydrated = new Map(
    layers.map((layer) => [layer.repoPath, layer.bytes]),
  );
  // MergeStrategy.merge returns only local bytes; the plan needs side files.
  const merged = mergeImport(
    selected.layers.map((layer) => ({
      label: layer.label,
      repoPath: layer.repoPath,
      bytes: hydrated.get(layer.repoPath),
    })),
    importName,
    eol,
  );
  if (!merged.ok) {
    const line = pushStatus(state, "ERROR", label, merged.error);
    recordStep(state, label, line, false);
    return;
  }

  ensureParentDir(state, localPath);
  applyBytes(state, label, localPath, label, merged.value.local, sanitized);

  const separator = separatorFor(state.snapshot.os);
  const folder = parentDir(localPath, separator);
  for (const side of merged.value.sideFiles) {
    const sidePath = joinPath(folder, side.name, separator);
    if (state.isExcluded(sidePath)) {
      pushStatus(state, "SKIPPED", side.repoPath, EXCLUDE_NOTE);
      continue;
    }
    applyBytes(
      state,
      side.repoPath,
      sidePath,
      side.repoPath,
      side.bytes,
      sanitized,
    );
  }
}

function planFile(state: State, selected: SelectedEntry): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }
  state.pending = [];

  const localPath = resolvedLocal(
    entry,
    state.snapshot.os,
    state.snapshot.home,
  );
  if (state.isExcluded(localPath)) {
    pushStatus(state, "SKIPPED", repoPath, EXCLUDE_NOTE);
    return;
  }

  const source = selected.source;
  const bytes =
    source === undefined
      ? undefined
      : state.snapshot.repoFiles.get(source.repoPath);
  if (source === undefined || bytes === undefined) {
    pushStatus(state, "SKIPPED", repoPath, REPO_MISSING_NOTE);
    state.skipped++;
    return;
  }

  const layers = hydratedLayers(state, selected, repoPath);
  if (layers === undefined) {
    return;
  }

  const eol = state.snapshot.os === "windows" ? "\r\n" : "\n";
  const sanitized = (entry.sanitize ?? []).length > 0;

  if (entry.merge === "import") {
    planImportFile(state, selected, layers, localPath, sanitized, eol);
    return;
  }

  const merged = mergedBytes(state, selected, layers, localPath, eol);
  if (!merged.ok) {
    const line = pushStatus(state, "ERROR", repoPath, merged.note);
    recordStep(state, repoPath, line, false);
    return;
  }

  // A json entry compares parsed, so key order, whitespace and line endings
  // alone leave the local file UNCHANGED, with no prompt and no backup.
  if (entry.merge === "json") {
    const local = state.snapshot.localFiles.get(localPath);
    if (
      local !== undefined &&
      local.kind === "file" &&
      sameJson(merged.bytes, local.bytes)
    ) {
      const line = pushStatus(state, "UNCHANGED", repoPath);
      recordStep(state, repoPath, line, false);
      return;
    }
  }

  ensureParentDir(state, localPath);
  applyBytes(state, repoPath, localPath, repoPath, merged.bytes, sanitized);
}

function planDir(state: State, selected: SelectedEntry): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  const separator = separatorFor(state.snapshot.os);
  const localDir = resolvedLocal(entry, state.snapshot.os, state.snapshot.home);
  const source = selected.source;

  if (source === undefined) {
    pushStatus(state, "SKIPPED", `${repoPath}/`, REPO_MISSING_NOTE);
    state.skipped++;
    return;
  }

  const repoPrefix = `${source.repoPath}/`;
  const repoNames = [...state.snapshot.repoFiles.keys()]
    .filter((path) => path.startsWith(repoPrefix))
    .sort();

  for (const repoName of repoNames) {
    state.pending = [];
    const relative = repoName.slice(repoPrefix.length);
    const label = `${repoPath}/${relative}`;
    if (!onlySelected(label, state.only)) {
      continue;
    }
    const localPath = joinPath(
      localDir,
      relative.replaceAll("/", separator),
      separator,
    );
    if (state.isExcluded(localPath)) {
      pushStatus(state, "SKIPPED", label, EXCLUDE_NOTE);
      continue;
    }
    const bytes = state.snapshot.repoFiles.get(repoName);
    if (bytes === undefined) {
      continue;
    }
    ensureParentDir(state, localPath);
    applyBytes(state, label, localPath, repoName, bytes, false);
  }

  // Import never deletes: a local file the repo doesn't have is EXTRA and kept.
  const localPrefix = `${localDir}${separator}`;
  const localPaths = [...state.snapshot.localFiles.keys()]
    .filter((path) => path.startsWith(localPrefix))
    .sort();
  for (const localPath of localPaths) {
    const local = state.snapshot.localFiles.get(localPath);
    if (local === undefined || local.kind !== "file") {
      continue;
    }
    const relative = localPath
      .slice(localPrefix.length)
      .replaceAll(separator, "/");
    const label = `${repoPath}/${relative}`;
    if (!onlySelected(label, state.only)) {
      continue;
    }
    if (state.snapshot.repoFiles.has(`${source.repoPath}/${relative}`)) {
      continue;
    }
    if (state.isExcluded(localPath)) {
      continue;
    }
    pushStatus(state, "EXTRA", label, EXTRA_NOTE);
  }
}

/** Contract "Backups": a dconf entry's backup sits under the state folder. */
function dconfBackupPath(snapshot: Snapshot, repoPath: string): string {
  const separator = separatorFor(snapshot.os);
  const folder = joinPath(
    snapshot.home,
    `.local${separator}state${separator}sync-settings${separator}dconf`,
    separator,
  );
  return joinPath(folder, `${basename(repoPath)}.bak`, separator);
}

/** A dump as bash keeps it: command substitution drops its trailing newlines. */
function dumpText(text: string): string {
  return text.replace(/\n+$/, "");
}

/**
 * Contract "dconf entries" and table "Import": merge the repo file into its
 * dconf folder, keeping a `.bak` of the old dump before every `UPDATED`. The
 * guards and their order are `import_dconf` in `import.sh`.
 */
function planDconf(state: State, selected: SelectedEntry): void {
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }
  state.pending = [];

  const entry = selected.entry;
  const dconfPath = entry.dconfPath;
  const dumps =
    state.snapshot.os === "linux" ? state.snapshot.dconfDumps : undefined;
  const dump = dconfPath === undefined ? undefined : dumps?.get(dconfPath);
  if (dconfPath === undefined || dump === undefined) {
    // Windows and macOS never run dconf, and a snapshot without the dump has
    // nothing to compare.
    pushStatus(state, "SKIPPED", repoPath, DCONF_NOTE);
    state.skipped++;
    return;
  }

  const repoBytes = state.snapshot.repoFiles.get(repoPath);
  if (repoBytes === undefined) {
    pushStatus(state, "SKIPPED", repoPath, REPO_MISSING_NOTE);
    state.skipped++;
    return;
  }

  if (dump.kind === "missing") {
    pushStatus(state, "SKIPPED", repoPath, DCONF_MISSING_NOTE);
    state.skipped++;
    return;
  }

  // dconf writes reach the service of the login session, so a throwaway HOME
  // or another XDG_CONFIG_HOME would still change the real desktop.
  if (
    state.snapshot.loginHome === undefined ||
    state.snapshot.home !== state.snapshot.loginHome
  ) {
    pushStatus(state, "SKIPPED", repoPath, DCONF_HOME_NOTE);
    state.skipped++;
    return;
  }
  const configHome = state.snapshot.env.XDG_CONFIG_HOME;
  if (
    configHome !== undefined &&
    configHome !== "" &&
    configHome !== `${state.snapshot.home}/.config`
  ) {
    pushStatus(state, "SKIPPED", repoPath, DCONF_CONFIG_NOTE);
    state.skipped++;
    return;
  }

  if (dump.kind === "failed") {
    pushStatus(state, "ERROR", repoPath, DCONF_FAILED_NOTE);
    return;
  }

  const repoText = new TextDecoder().decode(repoBytes);
  const current = dumpText(dump.text);
  const load: StepAction = {
    action: { kind: "dconfLoad", path: dconfPath, text: repoText },
    failure: DCONF_LOAD_FAILURE,
  };

  // Nothing set under the folder yet: load with no prompt and no backup.
  if (current === "") {
    state.pending.push(load);
    const line = pushStatus(state, "CREATED", repoPath);
    recordStep(state, repoPath, line, true);
    return;
  }

  // A load only adds or replaces the keys it names, so a key only the machine
  // has is not a difference (contract "Import merges; it never resets").
  if (!dconfNeedsLoad(repoText, current)) {
    const line = pushStatus(state, "UNCHANGED", repoPath);
    recordStep(state, repoPath, line, false);
    return;
  }

  if (!overwriteAccepted(state, dconfPath)) {
    const line = pushStatus(state, "SKIPPED", repoPath, USER_SKIPPED_NOTE);
    state.skipped++;
    recordStep(state, repoPath, line, false);
    return;
  }

  state.pending.push({
    action: {
      kind: "writeState",
      path: dconfBackupPath(state.snapshot, repoPath),
      text: `${current}\n`,
      repoPath,
    },
    failure: BACKUP_FAILURE,
  });
  state.pending.push(load);
  const line = pushStatus(
    state,
    "UPDATED",
    repoPath,
    `backup saved as ${basename(repoPath)}.bak`,
  );
  recordStep(state, repoPath, line, true);
}

/** The state file of contract "Sync point" for this OS. */
function lastSyncFile(snapshot: Snapshot): string {
  const separator = separatorFor(snapshot.os);
  if (snapshot.os === "windows") {
    const localAppData = snapshot.env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData !== ""
        ? localAppData
        : joinPath(snapshot.home, `AppData${separator}Local`, separator);
    return joinPath(
      joinPath(base, "SyncSettings", separator),
      SYNC_POINT_FILE,
      separator,
    );
  }
  const stateHome = snapshot.env.XDG_STATE_HOME;
  const base =
    stateHome !== undefined && stateHome !== ""
      ? stateHome
      : joinPath(snapshot.home, `.local${separator}state`, separator);
  return joinPath(
    joinPath(base, "sync-settings", separator),
    SYNC_POINT_FILE,
    separator,
  );
}

/** Contract "Sync point": every condition must hold before HEAD is recorded. */
function shouldRecordSyncPoint(state: State): boolean {
  if (state.only.length > 0) {
    return false;
  }
  if (state.errors > 0) {
    return false;
  }
  if (state.userSkips > 0) {
    return false;
  }
  const head = state.snapshot.head;
  if (head === undefined || head === "") {
    return false;
  }
  return state.snapshot.porcelain === "";
}

/**
 * The sanitize rules the picked entries need and the values every entry can
 * infer. `--only` keeps the rules narrow, but never the inference.
 */
function collectRules(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
  only: readonly string[],
): { readonly rules: readonly SanitizeRule[]; readonly inferred: Values } {
  const rules: SanitizeRule[] = [];
  const inferred = new Map<string, string>();

  for (const entry of selected) {
    if (entry.entry.merge === "dir" || entry.entry.merge === "dconf") {
      continue;
    }
    const entryRules = entry.entry.sanitize ?? [];
    if (entryRules.length === 0) {
      continue;
    }
    const source = entry.source;
    const repoBytes =
      source === undefined
        ? undefined
        : snapshot.repoFiles.get(source.repoPath);
    if (repoBytes === undefined) {
      continue;
    }
    if (entrySelected(entry, only)) {
      rules.push(...entryRules);
    }

    // Inference ignores --only: every selected entry whose repo and local file
    // exist can contribute a value, and it is saved like any other.
    const localPath = resolvedLocal(entry.entry, snapshot.os, snapshot.home);
    const local = snapshot.localFiles.get(localPath);
    if (local === undefined || local.kind !== "file") {
      continue;
    }
    for (const [placeholder, value] of Object.entries(
      inferValues(local.bytes, repoBytes, entryRules),
    )) {
      if (!inferred.has(placeholder)) {
        inferred.set(placeholder, value);
      }
    }
  }

  return { rules, inferred: Object.fromEntries(inferred) };
}

/** What `prepareImport` resolved before any answer is read. */
interface PreparedImport {
  readonly snapshot: Snapshot;
  readonly selected: readonly SelectedEntry[];
  readonly only: readonly string[];
  readonly gathered: {
    readonly rules: readonly SanitizeRule[];
    readonly inferred: Values;
  };
  readonly owner: ValueOwner | undefined;
}

/**
 * The entries, `--only` paths, sanitize rules and value owner an import reads
 * from its snapshot, or the plan of an early error (config or `--only`).
 */
function prepareImport(snapshot: Snapshot): PreparedImport | RunPlan {
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return errorPlan(selected.error.message, selected.error.code);
  }

  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return only.plan;
  }

  return {
    snapshot,
    selected: selected.value,
    only: only.paths,
    gathered: collectRules(snapshot, selected.value, only.paths),
    owner: valueOwner(snapshot),
  };
}

function isPrepared(value: PreparedImport | RunPlan): value is PreparedImport {
  return "selected" in value;
}

/** The default a value prompt shows in brackets: the cached value, the rule's
 * `default`, then the environment variable `defaultEnv` names. */
function promptFallback(
  rule: SanitizeRule,
  cached: Values,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const cachedValue = cached[rule.placeholder];
  if (cachedValue !== undefined && cachedValue.length > 0) {
    return cachedValue;
  }
  if (rule.default !== undefined && rule.default.length > 0) {
    return rule.default;
  }
  const fromEnv =
    rule.defaultEnv === undefined ? undefined : env[rule.defaultEnv];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : "";
}

/** One value question an import prints, and whether its answer may be empty:
 * a `--reset-values` question that shows a default in brackets takes the
 * default, while every other question stops the run on an empty answer. */
export interface ImportValueQuestion {
  readonly text: string;
  readonly hasDefault: boolean;
}

/** The `--reset-values` questions, one per placeholder, as `askValues` prints
 * them: its header first, then each default in brackets. */
function resetValueQuestions(
  snapshot: Snapshot,
  rules: readonly SanitizeRule[],
): ImportValueQuestion[] {
  const questions: ImportValueQuestion[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const placeholder = rule.placeholder;
    if (placeholder.length === 0 || seen.has(placeholder)) {
      continue;
    }
    seen.add(placeholder);
    const fallback = promptFallback(rule, snapshot.values, snapshot.env);
    const prompt = rule.prompt ?? "";
    const hasDefault = fallback.length > 0;
    questions.push({
      text: hasDefault ? `  ${prompt} [${fallback}]: ` : `  ${prompt}: `,
      hasDefault,
    });
  }
  return questions;
}

/** The values an import resolved, or the plan that stopped it. The app prints
 * the value questions itself, before reading each answer. */
export type ImportValuesResult =
  | {
      readonly ok: true;
      readonly values: Values;
    }
  | { readonly ok: false; readonly plan: RunPlan };

/**
 * The questions an import asks, each with the text printed before its answer:
 * under `--reset-values` one per placeholder as `askValues` prints it, with
 * its default in brackets and `hasDefault` set; otherwise one per
 * `missingPlaceholders` rule, which is what nothing else fills. The first
 * question carries the header. The check path never asks. An early-error plan
 * comes back when the config or `--only` cannot be read.
 */
export function importValueQuestions(
  snapshot: Snapshot,
): readonly ImportValueQuestion[] | RunPlan {
  const prepared = prepareImport(snapshot);
  if (!isPrepared(prepared)) {
    return prepared;
  }
  const rules = prepared.gathered.rules;
  const questions: ImportValueQuestion[] =
    snapshot.resetValues === true
      ? resetValueQuestions(snapshot, rules)
      : missingPlaceholders(
          rules,
          snapshot.values,
          prepared.gathered.inferred,
          snapshot.env,
        ).map((rule) => ({
          text: `  ${rule.prompt ?? ""}: `,
          hasDefault: false,
        }));
  const first = questions[0];
  if (first !== undefined) {
    questions[0] = {
      text: `${ASK_HEADER}${first.text}`,
      hasDefault: first.hasDefault,
    };
  }
  return questions;
}

/** Whether `importValueQuestions` returned questions rather than an early-error plan. */
export function isQuestionList(
  value: readonly ImportValueQuestion[] | RunPlan,
): value is readonly ImportValueQuestion[] {
  return Array.isArray(value);
}

/**
 * Resolve the import's values: `--reset-values` asks each placeholder again
 * from `valueAnswers`; otherwise the placeholders nothing else fills take one
 * answer each, and an empty or absent answer leaves its value missing. The
 * answers join the resolved values, so they are saved like `--reset-values`
 * saves them.
 */
export function resolveImportValues(
  snapshot: Snapshot,
  valueAnswers: readonly string[],
): ImportValuesResult {
  const prepared = prepareImport(snapshot);
  if (!isPrepared(prepared)) {
    return { ok: false, plan: prepared };
  }

  if (snapshot.resetValues === true) {
    // `--reset-values` asks again for every placeholder and skips inference.
    const asked = askValues(
      prepared.gathered.rules,
      snapshot.values,
      snapshot.env,
      valueAnswers,
      prepared.owner,
    );
    if (!asked.ok) {
      const placeholder = asked.error.placeholder;
      return {
        ok: false,
        plan: {
          ...errorPlan(asked.error.message, 1),
          ...(placeholder !== undefined ? { missing: placeholder } : {}),
        },
      };
    }
    return { ok: true, values: asked.value };
  }

  const rules = prepared.gathered.rules;
  const missing = missingPlaceholders(
    rules,
    snapshot.values,
    prepared.gathered.inferred,
    snapshot.env,
  );
  const answered = new Map<string, string>(Object.entries(snapshot.values));
  for (const [index, rule] of missing.entries()) {
    const raw = index < valueAnswers.length ? valueAnswers[index] : undefined;
    const answer = trimAnswer(raw ?? "");
    if (answer.length > 0) {
      answered.set(rule.placeholder, answer);
    }
  }

  const resolved = resolveValues(
    rules,
    Object.fromEntries(answered),
    prepared.gathered.inferred,
    snapshot.env,
    prepared.owner,
  );
  if (!resolved.ok) {
    const placeholder = resolved.error.placeholder;
    return {
      ok: false,
      plan: {
        ...errorPlan(resolved.error.message, 1),
        ...(placeholder !== undefined ? { missing: placeholder } : {}),
      },
    };
  }
  return { ok: true, values: resolved.value };
}

/**
 * The plan body once the values are resolved: every status line, action and
 * the exit code the contract gives import, with `askOverwrite` deciding each
 * differing file (its `name` is what the prompt prints).
 */
function buildImportPlan(
  prepared: PreparedImport,
  values: Values,
  askOverwrite: (name: string) => boolean,
): RunPlan {
  const snapshot = prepared.snapshot;
  const state: State = {
    snapshot,
    values,
    only: prepared.only,
    isExcluded: compileExcludes(
      snapshot.config.excludePatterns ?? [],
      snapshot.os,
    ),
    askOverwrite,
    force: snapshot.force === true,
    steps: [],
    finish: [],
    lines: [],
    pending: [],
    skipped: 0,
    errors: 0,
    userSkips: 0,
    hits: 0,
    createdDirs: new Set<string>(),
  };

  for (const entry of prepared.selected) {
    if (!entrySelected(entry, prepared.only)) {
      continue;
    }
    switch (entry.entry.merge) {
      case "dir":
        planDir(state, entry);
        break;
      case "dconf":
        planDconf(state, entry);
        break;
      default:
        planFile(state, entry);
        break;
    }
  }

  let syncPoint: string | undefined;
  if (shouldRecordSyncPoint(state)) {
    syncPoint = snapshot.head;
    if (syncPoint !== undefined) {
      state.finish.push({
        kind: "writeState",
        path: lastSyncFile(snapshot),
        text: `${syncPoint}\n`,
      });
    }
  }

  const summary: ImportSummary = {
    kind: "import",
    onlyMatchedNothing: state.only.length > 0 && state.hits === 0,
    ...(syncPoint !== undefined ? { syncPoint } : {}),
  };
  return {
    // Bash saves every value whenever an entry has rules, before any file.
    prepare: valuesPrepare(
      snapshot,
      prepared.gathered.rules.length > 0,
      values,
    ),
    steps: state.steps,
    finish: state.finish,
    lines: state.lines,
    summary,
    code: 0,
  };
}

/**
 * The ordered overwrite questions an import asks once its values are resolved:
 * each differing file's prompt name, before any write. With `--force` there are
 * none.
 */
export function importOverwriteQuestions(
  snapshot: Snapshot,
  values: Values,
): readonly string[] {
  const prepared = prepareImport(snapshot);
  if (!isPrepared(prepared)) {
    return [];
  }
  const names: string[] = [];
  buildImportPlan(prepared, values, (name) => {
    names.push(name);
    return true;
  });
  return names;
}

/**
 * The import plan given resolved values and the overwrite answers, in the
 * order `importOverwriteQuestions` asked them. An exhausted list answers the
 * rest as yes, as the contract's empty answer and end of input do.
 */
export function importPlan(
  snapshot: Snapshot,
  values: Values,
  overwriteAnswers: readonly (string | undefined)[],
): RunPlan {
  const prepared = prepareImport(snapshot);
  if (!isPrepared(prepared)) {
    return prepared;
  }
  let index = 0;
  const askOverwrite = (): boolean => {
    const answer = overwriteAnswers[index];
    index++;
    if (answer === undefined) {
      return true;
    }
    const trimmed = trimAnswer(answer);
    if (trimmed === "") {
      return true;
    }
    return /^[Yy]/.test(trimmed);
  };
  return buildImportPlan(prepared, values, askOverwrite);
}

/**
 * The import plan from one list of answers: the value answers first, one per
 * `importValueQuestions`, then the overwrite answers. Callers that ask each
 * question as it comes use `resolveImportValues`, `importOverwriteQuestions`
 * and `importPlan` instead.
 */
export function planImport(
  snapshot: Snapshot,
  answers: readonly string[],
): RunPlan {
  const questions = importValueQuestions(snapshot);
  if (!isQuestionList(questions)) {
    return questions;
  }
  const resolved = resolveImportValues(
    snapshot,
    answers.slice(0, questions.length),
  );
  if (!resolved.ok) {
    return resolved.plan;
  }
  return importPlan(snapshot, resolved.values, answers.slice(questions.length));
}
