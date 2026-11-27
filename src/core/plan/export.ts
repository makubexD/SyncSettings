import { containsNul, foldCrlf, same } from "../compare.ts";
import { valueEnv } from "../values/env.ts";
import type {
  ConfigV2,
  ConfigV2Entry,
  Os,
  SanitizeRule,
} from "../config/types.ts";
import { parseJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import { selectEntries } from "../layers/select.ts";
import type { LayerName, SelectedEntry } from "../layers/select.ts";
import { exportDconf } from "../merge/dconf.ts";
import { strategyFor } from "../merge/strategy.ts";
import type { LayerFile, SplitContext } from "../merge/types.ts";
import { formatLine } from "../status.ts";
import type { StatusWord } from "../status.ts";
import {
  hydrate,
  missingPlaceholders,
  placeholderFiles,
  resolveValues,
} from "../values/hydrate.ts";
import type { MissingValue, RuleSource } from "../values/hydrate.ts";
import { encodeUtf8, sanitize } from "../values/sanitize.ts";
import type { Values } from "../values/sanitize.ts";
import { compactJson, fileLabel, valueText } from "./changes.ts";
import { exportInferredValues } from "./infer.ts";
import { valuesPrepare } from "./machine-values.ts";
import { entryDestinations } from "./newsettings.ts";
import {
  compileExcludes,
  configuredLocal,
  entrySelected,
  entrySkipped,
  errorPlan,
  isJsonEntry,
  joinPath,
  onlySelected,
  pathSkipped,
  primaryRepoPath,
  resolvedLocal,
  resolveOnly,
  scopeFor,
  separatorFor,
} from "./pick.ts";
import type {
  ExportSummary,
  FileStep,
  LocalFile,
  NewSettingLine,
  RunPlan,
  Snapshot,
  StepAction,
} from "./types.ts";

const BASE_ROOT = "dotfiles/common/";

/** Contract "Orphan report": only files under `dotfiles/` can be orphans. */
const REPO_TREE = "dotfiles/";

const ALL_OS: readonly Os[] = ["windows", "linux", "macos"];

const EXCLUDE_NOTE = "matches exclude pattern";

const ORPHAN_NOTE = "no entry in sync-config.json; git rm it or add an entry";

const DCONF_NOTE = "not supported yet";

const DCONF_MISSING_NOTE = "dconf not installed";

const DCONF_FAILED_NOTE = "dconf dump failed";

const WRITE_DCONF_FAILURE = "cannot write repo file";

const EMPTY_FOLDER_NOTE = "local folder is empty; repo files kept";

const WRITE_SANITIZED_FAILURE = "cannot write repo file";

const COPY_TO_REPO_FAILURE = "cannot copy to repo";

const COPY_MODE_FAILURE = "cannot copy file mode";

const REMOVE_REPO_FAILURE = "cannot remove from repo";

const CREATE_PARENT_FOLDER_FAILURE = "cannot create parent folder";

const SANITIZED_NOTE = "sanitized";

const LOCAL_UNREADABLE = "cannot read local file";

interface State {
  readonly snapshot: Snapshot;
  readonly values: Values;
  readonly only: readonly string[];
  readonly isExcluded: (path: string) => boolean;
  /** The profile's stored destinations and this run's answers, destination key
   * (`<module> <file>: <path>`) to layer slot. */
  readonly destinations: ReadonlyMap<string, LayerName>;
  readonly steps: FileStep[];
  readonly lines: string[];
  readonly newSettings: NewSettingLine[];
  readonly errorLines: string[];
  pending: StepAction[];
  changed: number;
  skipped: number;
  hits: number;
}

/**
 * Contract "Line endings": a shared file in the repo holds LF, so a Windows
 * local file's CRLF pairs are folded before it is written. Any other path, and
 * a NUL byte's binary file, keeps the bytes as they are.
 */
function repoBytes(
  snapshot: Snapshot,
  repoPath: string,
  bytes: Uint8Array,
): Uint8Array {
  if (
    snapshot.os === "windows" &&
    repoPath.startsWith(BASE_ROOT) &&
    !containsNul(bytes)
  ) {
    return foldCrlf(bytes);
  }
  return bytes;
}

function compareOptions(
  snapshot: Snapshot,
  repoPath: string,
  sanitized: boolean,
) {
  return {
    os: snapshot.os,
    shared: repoPath.startsWith(BASE_ROOT),
    sanitized,
  };
}

function pushStatus(
  state: State,
  word: StatusWord,
  label: string,
  note?: string,
): number {
  const text = formatLine(word, label, note);
  state.lines.push(text);
  // A failed dconf dump says nothing about a file, and often only means no bus.
  if (word === "ERROR" && note !== DCONF_FAILED_NOTE) {
    state.errorLines.push(text);
  }
  state.hits++;
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

/**
 * `mkdir -p` a repo file's parent folder. A file entry names the folder, a dir
 * entry reports one fixed reason (`export.sh:140,227`).
 */
function mkdirParent(
  state: State,
  repoPath: string,
  fixedReason?: string,
): void {
  const slash = repoPath.lastIndexOf("/");
  if (slash > 0) {
    const parent = repoPath.slice(0, slash);
    state.pending.push({
      action: { kind: "mkdir", path: parent },
      failure: fixedReason ?? `cannot create ${parent}`,
    });
  }
}

/** The folder a path sits in, using this OS's own separator. */
function parentDir(path: string, separator: "/" | "\\"): string {
  const slash = path.lastIndexOf(separator);
  return slash <= 0 ? path : path.slice(0, slash);
}

/**
 * Each selected layer's bytes with the run's values put back, in layer order. A
 * layer the snapshot holds no file for is left out. The raw bytes stay beside
 * the hydrated ones: a whole split compares those, as the contract says, while
 * `json` and `import` work from the run's values. A missing value is
 * unreachable after `resolveValues`; it still gives the file its own `ERROR`.
 */
function hydratedLayers(
  state: State,
  selected: SelectedEntry,
  label: string,
): readonly LayerFile[] | undefined {
  const entry = selected.entry;
  const rules = entry.sanitize ?? [];
  const json = isJsonEntry(entry);
  const layers: LayerFile[] = [];
  for (const layer of selected.layers) {
    const bytes = state.snapshot.repoFiles.get(layer.repoPath);
    if (bytes === undefined) {
      continue;
    }
    if (rules.length === 0) {
      layers.push({ repoPath: layer.repoPath, bytes, label: layer.label });
      continue;
    }
    const hydrated = hydrate(bytes, rules, state.values, { json });
    if (!hydrated.ok) {
      const line = pushStatus(state, "ERROR", label, hydrated.error.message);
      recordStep(state, label, line, false);
      return undefined;
    }
    layers.push({
      repoPath: layer.repoPath,
      bytes,
      hydrated: hydrated.value,
      label: layer.label,
    });
  }
  return layers;
}

/**
 * Write one repo file with the status line export gives it: `ADDED` and a
 * `mkdir` for a layer new to the repo, `UNCHANGED` for the same content,
 * `MODIFIED` otherwise. `note` replaces the `sanitized` note, as a block edit
 * does on an import entry's base layer.
 */
function writeRepoFile(
  state: State,
  repoPath: string,
  local: LocalFile,
  bytes: Uint8Array,
  sanitized: boolean,
  note?: string,
): void {
  const writtenNote = note ?? (sanitized ? SANITIZED_NOTE : undefined);
  const failure = sanitized ? WRITE_SANITIZED_FAILURE : COPY_TO_REPO_FAILURE;
  const repo = state.snapshot.repoFiles.get(repoPath);

  if (repo === undefined) {
    mkdirParent(state, repoPath);
    state.pending.push({
      action: {
        kind: "writeRepo",
        path: repoPath,
        bytes: repoBytes(state.snapshot, repoPath, bytes),
      },
      failure,
    });
    state.pending.push({
      action: { kind: "chmod", path: repoPath, mode: local.mode },
      failure: COPY_MODE_FAILURE,
    });
    const line = pushStatus(state, "ADDED", repoPath, writtenNote);
    state.changed++;
    recordStep(state, repoPath, line, true);
    return;
  }

  if (same(repo, bytes, compareOptions(state.snapshot, repoPath, sanitized))) {
    pushStatus(state, "UNCHANGED", repoPath, note);
    return;
  }

  state.pending.push({
    action: {
      kind: "writeRepo",
      path: repoPath,
      bytes: repoBytes(state.snapshot, repoPath, bytes),
    },
    failure,
  });
  if (!sanitized) {
    state.pending.push({
      action: { kind: "chmod", path: repoPath, mode: local.mode },
      failure: COPY_MODE_FAILURE,
    });
  }
  const line = pushStatus(state, "MODIFIED", repoPath, writtenNote);
  state.changed++;
  recordStep(state, repoPath, line, true);
}

/** Contract "Layers (program only)": the profile's answers for new settings,
 * destination key to layer slot. The profile parser checked every slot name. */
function destinationsOf(snapshot: Snapshot): ReadonlyMap<string, LayerName> {
  const destinations = snapshot.profile?.destinations;
  if (destinations === undefined) {
    return new Map();
  }
  return new Map(
    Object.entries(destinations).map(([path, layer]) => [
      path,
      layer as LayerName,
    ]),
  );
}

/** The stored destinations with this run's answers on top: an answer names the
 * layer the user just picked, so it wins over a stored slot. Both are keyed by
 * destination key (`<module> <file>: <path>`). */
function mergedDestinations(
  snapshot: Snapshot,
  answers: ReadonlyMap<string, LayerName> | undefined,
): ReadonlyMap<string, LayerName> {
  const merged = new Map(destinationsOf(snapshot));
  if (answers !== undefined) {
    for (const [path, layer] of answers) {
      merged.set(path, layer);
    }
  }
  return merged;
}

/**
 * A new setting's `what`: its key path and compact value, sanitized as the
 * layer would hold it and cut as a change line is. `json` picks the escaped
 * value forms, as the plan's sanitize call on layer bytes does.
 */
function newSettingWhat(
  path: string,
  value: JsonValue,
  state: State,
  rules: readonly SanitizeRule[],
  json: boolean,
): string {
  const text = compactJson(value);
  if (rules.length === 0) {
    return `${path}: ${valueText(value)}`;
  }
  const sanitized = new TextDecoder().decode(
    sanitize(encodeUtf8(text), rules, state.values, { json }),
  );
  const parsed = parseJson(sanitized);
  if (!parsed.ok) {
    // shortcut: sanitize left text this value can't be read back from, so the
    // 60-character cut can't run; it is short in every case that can happen.
    return `${path}: ${sanitized}`;
  }
  return `${path}: ${valueText(parsed.value)}`;
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

  const local = state.snapshot.localFiles.get(localPath);
  if (local !== undefined && local.kind === "unreadable") {
    pushStatus(state, "ERROR", repoPath, LOCAL_UNREADABLE);
    return;
  }
  if (local === undefined || local.kind !== "file") {
    pushStatus(
      state,
      "SKIPPED",
      repoPath,
      `local file not found: ${localPath}`,
    );
    state.skipped++;
    return;
  }

  const strategy = strategyFor(entry.merge);
  if (strategy === undefined) {
    return;
  }

  const layers = hydratedLayers(state, selected, repoPath);
  if (layers === undefined) {
    return;
  }

  const rules = entry.sanitize ?? [];
  const sanitized = rules.length > 0;
  const file = fileLabel(entry.file);
  const sanitizeBytes = (bytes: Uint8Array): Uint8Array =>
    sanitized
      ? sanitize(bytes, rules, state.values, { json: isJsonEntry(entry) })
      : bytes;
  const compareWithRepo = compareOptions(state.snapshot, repoPath, sanitized);
  const context: SplitContext = {
    writeRepoPath: repoPath,
    // The split looks a key path up in this one file, so the entry's own
    // destinations take the module and file off the stored key.
    destinations: entryDestinations(state.destinations, entry.module, file),
    hasRecord: state.snapshot.record !== undefined,
    localOnlyKeys: entry.localOnlyKeys ?? [],
    slots: selected.slots,
    sanitize: sanitizeBytes,
    compare: (layer, compared) => same(layer, compared, compareWithRepo),
    ...(entry.importName !== undefined ? { importName: entry.importName } : {}),
  };
  const split = strategy.split(local.bytes, layers, context);
  if (!split.ok) {
    const line = pushStatus(state, "ERROR", repoPath, split.error);
    recordStep(state, repoPath, line, false);
    return;
  }
  const result = split.value;

  if (result.newSettings.length > 0) {
    for (const setting of result.newSettings) {
      const line = pushStatus(
        state,
        "ERROR",
        repoPath,
        `new setting ${setting.path}: needs a destination`,
      );
      recordStep(state, repoPath, line, false);
      state.newSettings.push({
        module: entry.module,
        file,
        path: setting.path,
        kind: setting.path.endsWith("[]") ? "item" : "key",
        what: newSettingWhat(
          setting.path,
          setting.value,
          state,
          rules,
          isJsonEntry(entry),
        ),
      });
    }
    return;
  }

  if (result.changes.length === 0) {
    pushStatus(state, "UNCHANGED", result.label, result.note);
  } else {
    for (const change of result.changes) {
      state.pending = [];
      writeRepoFile(
        state,
        change.repoPath,
        local,
        sanitizeBytes(change.bytes),
        sanitized,
        result.note,
      );
    }
  }

  const separator = separatorFor(state.snapshot.os);
  const folder = parentDir(local.path, separator);
  for (const side of result.sideFiles) {
    const sidePath = joinPath(folder, side.name, separator);
    const sideLocal = state.snapshot.localFiles.get(sidePath);
    if (sideLocal !== undefined && sideLocal.kind === "unreadable") {
      pushStatus(state, "ERROR", side.repoPath, LOCAL_UNREADABLE);
      continue;
    }
    if (sideLocal === undefined || sideLocal.kind !== "file") {
      // The snapshot reads an entry's own local path, not the layer files beside
      // it, so a side file it doesn't list has nothing to push: the layer file
      // stays as it is.
      pushStatus(state, "UNCHANGED", side.repoPath);
      continue;
    }
    if (state.isExcluded(sidePath)) {
      pushStatus(state, "SKIPPED", side.repoPath, EXCLUDE_NOTE);
      continue;
    }
    // Pull writes a side file with this OS's line endings; the layer file in
    // the repo holds LF, so fold as `splitImport` does for the base.
    state.pending = [];
    writeRepoFile(
      state,
      side.repoPath,
      sideLocal,
      sanitizeBytes(foldCrlf(sideLocal.bytes)),
      sanitized,
    );
  }
}

function planDir(state: State, selected: SelectedEntry): void {
  const repoPath = primaryRepoPath(selected);
  const separator = separatorFor(state.snapshot.os);
  const localDir = resolvedLocal(
    selected.entry,
    state.snapshot.os,
    state.snapshot.home,
  );

  if (!state.snapshot.localDirs.has(localDir)) {
    pushStatus(
      state,
      "SKIPPED",
      `${repoPath}/`,
      `local folder not found: ${localDir}`,
    );
    state.skipped++;
    return;
  }

  const localPrefix = `${localDir}${separator}`;
  const localPaths = [...state.snapshot.localFiles.keys()]
    .filter((path) => path.startsWith(localPrefix))
    .sort();
  let files = 0;

  for (const localPath of localPaths) {
    state.pending = [];
    const local = state.snapshot.localFiles.get(localPath);
    if (local === undefined) {
      continue;
    }
    const relative = localPath
      .slice(localPrefix.length)
      .replaceAll(separator, "/");
    const label = `${repoPath}/${relative}`;

    if (local.kind === "symlink") {
      pushStatus(state, "SKIPPED", label, "symlink");
      continue;
    }
    if (state.isExcluded(localPath)) {
      pushStatus(state, "SKIPPED", label, EXCLUDE_NOTE);
      continue;
    }

    files++;
    if (
      !onlySelected(label, state.only) ||
      pathSkipped(label, state.snapshot.skip)
    ) {
      continue;
    }
    if (local.kind === "unreadable") {
      pushStatus(state, "ERROR", label, LOCAL_UNREADABLE);
      continue;
    }
    const repo = state.snapshot.repoFiles.get(label);
    if (repo === undefined) {
      mkdirParent(state, label, CREATE_PARENT_FOLDER_FAILURE);
      state.pending.push({
        action: {
          kind: "writeRepo",
          path: label,
          bytes: repoBytes(state.snapshot, label, local.bytes),
        },
        failure: COPY_TO_REPO_FAILURE,
      });
      state.pending.push({
        action: { kind: "chmod", path: label, mode: local.mode },
        failure: COPY_MODE_FAILURE,
      });
      const line = pushStatus(state, "ADDED", label);
      state.changed++;
      recordStep(state, label, line, true);
    } else if (
      same(repo, local.bytes, compareOptions(state.snapshot, label, false))
    ) {
      pushStatus(state, "UNCHANGED", label);
    } else {
      state.pending.push({
        action: {
          kind: "writeRepo",
          path: label,
          bytes: repoBytes(state.snapshot, label, local.bytes),
        },
        failure: COPY_TO_REPO_FAILURE,
      });
      state.pending.push({
        action: { kind: "chmod", path: label, mode: local.mode },
        failure: COPY_MODE_FAILURE,
      });
      const line = pushStatus(state, "MODIFIED", label);
      state.changed++;
      recordStep(state, label, line, true);
    }
  }

  const repoPrefix = `${repoPath}/`;
  const repoNames = [...state.snapshot.repoFiles.keys()]
    .filter((path) => path.startsWith(repoPrefix))
    .sort();

  if (files === 0 && repoNames.length > 0) {
    pushStatus(state, "SKIPPED", `${repoPath}/`, EMPTY_FOLDER_NOTE);
    state.skipped++;
    return;
  }

  for (const repoName of repoNames) {
    state.pending = [];
    const relative = repoName.slice(repoPrefix.length);
    const localPath = `${localDir}${separator}${relative.replaceAll("/", separator)}`;
    const local = state.snapshot.localFiles.get(localPath);
    // A local file that exists keeps its repo copy, even when it can't be read.
    if (
      local !== undefined &&
      (local.kind === "file" || local.kind === "unreadable") &&
      !state.isExcluded(localPath)
    ) {
      continue;
    }
    if (
      !onlySelected(repoName, state.only) ||
      pathSkipped(repoName, state.snapshot.skip)
    ) {
      continue;
    }
    state.pending.push({
      action: { kind: "removeRepo", path: repoName, pruneUpTo: repoPath },
      failure: REMOVE_REPO_FAILURE,
    });
    const line = pushStatus(state, "REMOVED", repoName, "no longer in source");
    state.changed++;
    recordStep(state, repoName, line, true);
  }
}

/**
 * Contract "dconf entries", export: the dump filtered by `keys`, compared byte
 * for byte with the repo file. An empty result is `SKIPPED`; a missing `dconf`
 * and an empty folder skip without touching the repo file, and a failed dump
 * is an `ERROR`. Windows and macOS keep the whole entry `SKIPPED`.
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
    pushStatus(state, "SKIPPED", repoPath, DCONF_NOTE);
    state.skipped++;
    return;
  }

  switch (dump.kind) {
    case "missing":
      pushStatus(state, "SKIPPED", repoPath, DCONF_MISSING_NOTE);
      state.skipped++;
      return;
    case "failed":
      pushStatus(state, "ERROR", repoPath, DCONF_FAILED_NOTE);
      return;
    case "ok":
      break;
  }

  const result = exportDconf(
    dump.text,
    entry.keys,
    state.snapshot.repoFiles.get(repoPath),
  );
  if (result.status === "SKIPPED") {
    pushStatus(state, "SKIPPED", repoPath, `no settings under ${dconfPath}`);
    state.skipped++;
    return;
  }
  if (result.status === "UNCHANGED") {
    pushStatus(state, "UNCHANGED", repoPath);
    return;
  }

  if (result.status === "ADDED") {
    mkdirParent(state, repoPath);
  }
  state.pending.push({
    action: {
      kind: "writeRepo",
      path: repoPath,
      bytes: new TextEncoder().encode(result.text),
    },
    failure: WRITE_DCONF_FAILURE,
  });
  const line = pushStatus(state, result.status, repoPath);
  state.changed++;
  recordStep(state, repoPath, line, true);
}

function rootsFor(config: ConfigV2, entry: ConfigV2Entry): readonly string[] {
  const os = entry.os ?? config.modules[entry.module]?.os ?? ALL_OS;
  return [BASE_ROOT, ...os.map((system) => `dotfiles/${system}/`)];
}

/** Contract "Orphan report": owned by an entry on any platform. */
function orphanReport(state: State): void {
  const exact = new Set<string>();
  const folders: string[] = [];

  for (const entry of state.snapshot.config.entries) {
    for (const root of rootsFor(state.snapshot.config, entry)) {
      const repoPath = `${root}${entry.file}`;
      if (entry.merge === "dir") {
        folders.push(`${repoPath}/`);
      } else {
        exact.add(repoPath);
      }
    }
  }

  for (const path of [...state.snapshot.repoFiles.keys()].sort()) {
    // Profile and machine layer files live in the state folder, not the repo.
    if (!path.startsWith(REPO_TREE)) {
      continue;
    }
    const owned =
      exact.has(path) || folders.some((prefix) => path.startsWith(prefix));
    if (!owned) {
      pushStatus(state, "ORPHAN", path, ORPHAN_NOTE);
    }
  }
}

/**
 * The file entries this export sends and their rules can apply to: picked by
 * `--only`, not skipped, not `dir` or `dconf`, with a local file.
 */
function sentEntries(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
  onlyPaths: readonly string[],
): readonly SelectedEntry[] {
  return selected.filter((entry) => {
    if (
      !entrySelected(entry, onlyPaths) ||
      entrySkipped(entry, snapshot.skip) ||
      entry.entry.merge === "dir" ||
      entry.entry.merge === "dconf"
    ) {
      return false;
    }
    const localPath = resolvedLocal(entry.entry, snapshot.os, snapshot.home);
    return snapshot.localFiles.get(localPath)?.kind === "file";
  });
}

/**
 * The sanitize rules of the entries this export sends, each with the entry's
 * configured local path.
 */
function exportRules(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
  onlyPaths: readonly string[],
): readonly RuleSource[] {
  return sentEntries(snapshot, selected, onlyPaths).map((entry) => ({
    rules: entry.entry.sanitize ?? [],
    file: configuredLocal(entry.entry, snapshot.os),
  }));
}

/** A file an export can't sanitize yet: its repo path and the first
 * placeholder of its rules that has no value. */
export interface ValueGap {
  readonly label: string;
  readonly placeholder: string;
}

/**
 * Contract "Export preview": the entries this export sends that hold a
 * placeholder nothing fills, in entry order, each with the first such
 * placeholder in its rule order. Empty when nothing is missing, or when the
 * config or `--only` stops the export.
 */
export function exportValueGaps(snapshot: Snapshot): readonly ValueGap[] {
  const missing = new Set(
    exportMissingRules(snapshot).map(({ rule }) => rule.placeholder),
  );
  if (missing.size === 0) {
    return [];
  }
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return [];
  }
  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return [];
  }
  const gaps: ValueGap[] = [];
  for (const entry of sentEntries(snapshot, selected.value, only.paths)) {
    const rule = (entry.entry.sanitize ?? []).find((candidate) =>
      missing.has(candidate.placeholder),
    );
    if (rule !== undefined) {
      gaps.push({
        label: primaryRepoPath(entry),
        placeholder: rule.placeholder,
      });
    }
  }
  return gaps;
}

/**
 * The sanitize rules of every file entry this machine syncs that `--only`
 * picks, whether or not this export sends it: a skipped entry and one with no
 * local file still count, since a later push or pull needs the value
 * (contract "Push asks"). `dir` and `dconf` entries ignore `sanitize`.
 */
function syncedRules(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
  onlyPaths: readonly string[],
): readonly RuleSource[] {
  return selected
    .filter(
      (entry) =>
        entrySelected(entry, onlyPaths) &&
        entry.entry.merge !== "dir" &&
        entry.entry.merge !== "dconf",
    )
    .map((entry) => ({
      rules: entry.entry.sanitize ?? [],
      file: configuredLocal(entry.entry, snapshot.os),
    }));
}

/**
 * Contract "Push asks": the rules whose placeholder nothing fills (saved,
 * inferred, `default`, `defaultEnv`), one per placeholder in rule order, for
 * every file entry this machine syncs that `--only` picks, sent or not, each
 * with the files that need it.
 * Empty when the config or `--only` stops the export, since `planExport`
 * reports that itself.
 */
export function exportMissingRules(
  snapshot: Snapshot,
): readonly MissingValue[] {
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return [];
  }
  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return [];
  }
  const sources = syncedRules(snapshot, selected.value, only.paths);
  const files = placeholderFiles(sources);
  return missingPlaceholders(
    sources.flatMap((source) => source.rules),
    snapshot.values,
    exportInferredValues(snapshot, selected.value),
    valueEnv(snapshot.env, snapshot.home, snapshot.os),
  ).map((rule) => ({ rule, files: files.get(rule.placeholder) ?? [] }));
}

/**
 * The export plan: every status line, action and the exit code the contract
 * gives export, from a snapshot and nothing else. `answers` are this run's
 * choices for new settings, destination key to layer slot; they join the
 * profile's stored destinations, so an answered setting is written instead of
 * listed in `newSettings`.
 */
export function planExport(
  snapshot: Snapshot,
  answers?: ReadonlyMap<string, LayerName>,
): RunPlan {
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

  const rules = exportRules(snapshot, selected.value, only.paths).flatMap(
    (source) => source.rules,
  );
  // Contract "Inference": export reads the values from this machine's files
  // as import does, so a machine with no saved value can still push.
  const values = resolveValues(
    rules,
    snapshot.values,
    exportInferredValues(snapshot, selected.value),
    valueEnv(snapshot.env, snapshot.home, snapshot.os),
  );
  if (!values.ok) {
    const placeholder = values.error.placeholder;
    return {
      ...errorPlan(values.error.message, 1),
      ...(placeholder !== undefined ? { missing: placeholder } : {}),
    };
  }

  const state: State = {
    snapshot,
    values: values.value,
    only: only.paths,
    isExcluded: compileExcludes(
      snapshot.config.excludePatterns ?? [],
      snapshot.os,
    ),
    destinations: mergedDestinations(snapshot, answers),
    steps: [],
    lines: [],
    newSettings: [],
    errorLines: [],
    pending: [],
    changed: 0,
    skipped: 0,
    hits: 0,
  };

  for (const entry of selected.value) {
    if (
      !entrySelected(entry, only.paths) ||
      entrySkipped(entry, snapshot.skip)
    ) {
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

  if (only.paths.length === 0) {
    orphanReport(state);
  }

  const summary: ExportSummary = {
    kind: "export",
    onlyMatchedNothing: state.only.length > 0 && state.hits === 0,
    skipped: state.skipped,
  };
  return {
    // Bash saves every value whenever an entry with rules has a local file;
    // answers this run asked are saved too, for whichever entry needs them.
    prepare: valuesPrepare(
      snapshot,
      rules.length > 0 || snapshot.valuesAnswered === true,
      values.value,
    ),
    steps: state.steps,
    finish: [],
    lines: state.lines,
    summary,
    code: 0,
    ...(state.newSettings.length > 0 ? { newSettings: state.newSettings } : {}),
    ...(state.errorLines.length > 0 ? { errorLines: state.errorLines } : {}),
  };
}
