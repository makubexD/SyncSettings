import { same } from "../compare.ts";
import type { SanitizeRule } from "../config/types.ts";
import { jsonEqual, parseJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import { selectEntries } from "../layers/select.ts";
import type { SelectedEntry } from "../layers/select.ts";
import { mergeImport } from "../merge/import.ts";
import { mergeJson } from "../merge/json.ts";
import { strategyFor } from "../merge/strategy.ts";
import type { LayerFile } from "../merge/types.ts";
import { formatLine } from "../status.ts";
import type { StatusWord } from "../status.ts";
import { valuesFileText } from "../values/file.ts";
import { hydrate, inferValues, resolveValues } from "../values/hydrate.ts";
import type { Values } from "../values/sanitize.ts";
import {
  basename,
  compileExcludes,
  entrySelected,
  errorPlan,
  joinPath,
  onlySelected,
  primaryRepoPath,
  resolvedLocal,
  resolveOnly,
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

const DCONF_NOTE = "not supported yet";

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
  readonly answers: readonly string[];
  readonly force: boolean;
  readonly steps: FileStep[];
  readonly finish: Action[];
  readonly lines: string[];
  pending: StepAction[];
  answerIndex: number;
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

/** Contract "Overwrite prompt": an empty answer and end of input both mean yes. */
function overwriteAccepted(state: State): boolean {
  if (state.force) {
    return true;
  }
  const answer = state.answers[state.answerIndex];
  state.answerIndex++;
  if (answer === undefined) {
    return true;
  }
  const trimmed = answer.trim();
  if (trimmed === "") {
    return true;
  }
  return /^[Yy]/.test(trimmed);
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
    if (!overwriteAccepted(state)) {
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
  const json = entry.merge === "json" || entry.file.endsWith(".json");
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
    const hydrated = hydrate(bytes, rules, state.values, { json });
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
): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly note: string } {
  const entry = selected.entry;
  if (entry.merge === "json") {
    const local = state.snapshot.localFiles.get(localPath);
    const merged = mergeJson(layers, eol, {
      bytes: local !== undefined && local.kind === "file" ? local.bytes : undefined,
      localOnlyKeys: entry.localOnlyKeys ?? [],
    });
    return merged.ok
      ? { ok: true, bytes: merged.value }
      : { ok: false, note: merged.error };
  }
  const strategy = strategyFor("whole");
  if (strategy === undefined) {
    throw new Error("merge type whole has no strategy");
  }
  const merged = strategy.merge(layers, { eol });
  return merged.ok
    ? { ok: true, bytes: merged.value }
    : { ok: false, note: merged.error };
}

/** The JSON value a file holds, or undefined when it isn't valid UTF-8 JSON. */
function parsedJson(bytes: Uint8Array): JsonValue | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Invalid UTF-8 is not JSON, as in the merge.
    return undefined;
  }
  const parsed = parseJson(text);
  return parsed.ok ? parsed.value : undefined;
}

/** Whether two files hold the same JSON value, whatever their layout. */
function sameJson(left: Uint8Array, right: Uint8Array): boolean {
  const leftValue = parsedJson(left);
  const rightValue = parsedJson(right);
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
  const hydrated = new Map(layers.map((layer) => [layer.repoPath, layer.bytes]));
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
    applyBytes(state, side.repoPath, sidePath, side.repoPath, side.bytes, sanitized);
  }
}

function planFile(state: State, selected: SelectedEntry): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }
  state.pending = [];

  const localPath = resolvedLocal(entry, state.snapshot.os, state.snapshot.home);
  if (state.isExcluded(localPath)) {
    pushStatus(state, "SKIPPED", repoPath, EXCLUDE_NOTE);
    return;
  }

  const source = selected.source;
  const bytes = source === undefined ? undefined : state.snapshot.repoFiles.get(source.repoPath);
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
    const localPath = joinPath(localDir, relative.replaceAll("/", separator), separator);
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
    const relative = localPath.slice(localPrefix.length).replaceAll(separator, "/");
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

function planDconf(state: State, selected: SelectedEntry): void {
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }
  pushStatus(state, "SKIPPED", repoPath, DCONF_NOTE);
  state.skipped++;
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
    return joinPath(joinPath(base, "SyncSettings", separator), SYNC_POINT_FILE, separator);
  }
  const stateHome = snapshot.env.XDG_STATE_HOME;
  const base =
    stateHome !== undefined && stateHome !== ""
      ? stateHome
      : joinPath(snapshot.home, `.local${separator}state`, separator);
  return joinPath(joinPath(base, "sync-settings", separator), SYNC_POINT_FILE, separator);
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
    const repoBytes = source === undefined ? undefined : snapshot.repoFiles.get(source.repoPath);
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

/**
 * The import plan: every status line, action and the exit code the contract
 * gives import, from a snapshot, the `--force` flag and the prompt answers.
 */
export function planImport(
  snapshot: Snapshot,
  answers: readonly string[],
): RunPlan {
  const selected = selectEntries(
    snapshot.config,
    {
      os: snapshot.os,
      ...(snapshot.profile !== undefined ? { profile: snapshot.profile } : {}),
      ...(snapshot.machine !== undefined ? { machine: snapshot.machine } : {}),
    },
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return errorPlan(selected.error.message, selected.error.code);
  }

  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return only.plan;
  }

  const gathered = collectRules(snapshot, selected.value, only.paths);
  const values = resolveValues(gathered.rules, snapshot.values, gathered.inferred, snapshot.env);
  if (!values.ok) {
    return errorPlan(values.error.message, 1);
  }

  const state: State = {
    snapshot,
    values: values.value,
    only: only.paths,
    isExcluded: compileExcludes(snapshot.config.excludePatterns ?? [], snapshot.os),
    answers,
    force: snapshot.force === true,
    steps: [],
    finish: [],
    lines: [],
    pending: [],
    answerIndex: 0,
    skipped: 0,
    errors: 0,
    userSkips: 0,
    hits: 0,
    createdDirs: new Set<string>(),
  };

  for (const entry of selected.value) {
    if (!entrySelected(entry, only.paths)) {
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
    prepare:
      gathered.rules.length > 0
        ? [{ kind: "writeValues", text: valuesFileText(values.value) }]
        : [],
    steps: state.steps,
    finish: state.finish,
    lines: state.lines,
    summary,
    code: 0,
  };
}
