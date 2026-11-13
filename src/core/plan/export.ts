import { same } from "../compare.ts";
import type { ConfigV2, ConfigV2Entry, Os, SanitizeRule } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import type { Layer, SelectedEntry } from "../layers/select.ts";
import { splitImport } from "../merge/import.ts";
import { splitJson } from "../merge/json.ts";
import type { JsonLayer } from "../merge/json.ts";
import { formatLine } from "../status.ts";
import type { StatusWord } from "../status.ts";
import { valuesFileText } from "../values/file.ts";
import { hydrate, resolveValues } from "../values/hydrate.ts";
import { sanitize } from "../values/sanitize.ts";
import type { Values } from "../values/sanitize.ts";
import {
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
  ExportSummary,
  FileStep,
  LocalFile,
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

const EMPTY_FOLDER_NOTE = "local folder is empty; repo files kept";

const WRITE_SANITIZED_FAILURE = "cannot write repo file";

const COPY_TO_REPO_FAILURE = "cannot copy to repo";

const COPY_MODE_FAILURE = "cannot copy file mode";

const REMOVE_REPO_FAILURE = "cannot remove from repo";

const CREATE_PARENT_FOLDER_FAILURE = "cannot create parent folder";

const SANITIZED_NOTE = "sanitized";

const IMPORT_NAME_NOTE = "needs {layer} in importName";

const IMPORT_BLOCK_NOTE = "import block is written by mksync, edit not pushed";

/** One layer's bytes with its values put back, ready for a split. */
interface HydratedLayer {
  readonly layer: Layer;
  readonly bytes: Uint8Array;
}

interface State {
  readonly snapshot: Snapshot;
  readonly values: Values;
  readonly only: readonly string[];
  readonly isExcluded: (path: string) => boolean;
  readonly steps: FileStep[];
  readonly lines: string[];
  pending: StepAction[];
  changed: number;
  skipped: number;
  hits: number;
}

function compareOptions(snapshot: Snapshot, repoPath: string, sanitized: boolean) {
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
  state.lines.push(formatLine(word, label, note));
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
function mkdirParent(state: State, repoPath: string, fixedReason?: string): void {
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
 * layer the snapshot holds no file for is left out. A missing value is
 * unreachable after `resolveValues`; it still gives the file its own `ERROR`.
 */
function hydratedLayers(
  state: State,
  selected: SelectedEntry,
  label: string,
): readonly HydratedLayer[] | undefined {
  const entry = selected.entry;
  const rules = entry.sanitize ?? [];
  const json = entry.merge === "json" || entry.file.endsWith(".json");
  const layers: HydratedLayer[] = [];
  for (const layer of selected.layers) {
    const bytes = state.snapshot.repoFiles.get(layer.repoPath);
    if (bytes === undefined) {
      continue;
    }
    if (rules.length === 0) {
      layers.push({ layer, bytes });
      continue;
    }
    const hydrated = hydrate(bytes, rules, state.values, { json });
    if (!hydrated.ok) {
      const line = pushStatus(state, "ERROR", label, hydrated.error.message);
      recordStep(state, label, line, false);
      return undefined;
    }
    layers.push({ layer, bytes: hydrated.value });
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
      action: { kind: "writeRepo", path: repoPath, bytes },
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
    action: { kind: "writeRepo", path: repoPath, bytes },
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

/**
 * Contract "Layers (program only)", json export: split the local file into its
 * layers, sanitize each changed layer and write it. A new setting with no
 * destination is an `ERROR` for the file and nothing of it is written.
 */
function planJsonFile(
  state: State,
  selected: SelectedEntry,
  local: LocalFile,
  hydrated: readonly HydratedLayer[],
): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  const layers: JsonLayer[] = hydrated.map((item) => ({
    name: item.layer.name,
    repoPath: item.layer.repoPath,
    bytes: item.bytes,
  }));
  const split = splitJson(local.bytes, layers, {
    localOnlyKeys: entry.localOnlyKeys ?? [],
  });
  if (!split.ok) {
    const line = pushStatus(state, "ERROR", repoPath, split.error);
    recordStep(state, repoPath, line, false);
    return;
  }

  if (split.value.newSettings.length > 0) {
    for (const setting of split.value.newSettings) {
      const line = pushStatus(
        state,
        "ERROR",
        repoPath,
        `new setting ${setting.path}: needs a destination`,
      );
      recordStep(state, repoPath, line, false);
    }
    return;
  }

  if (split.value.changes.length === 0) {
    pushStatus(state, "UNCHANGED", repoPath);
    return;
  }

  const rules = entry.sanitize ?? [];
  const sanitized = rules.length > 0;
  for (const change of split.value.changes) {
    const bytes = sanitized
      ? sanitize(change.bytes, rules, state.values, {
          json: entry.file.endsWith(".json"),
        })
      : change.bytes;
    state.pending = [];
    writeRepoFile(state, change.repoPath, local, bytes, sanitized);
  }
}

/**
 * Contract "Layers (program only)", import export: the text above the marker
 * goes to the base layer, a block edit prints its note, and each later layer's
 * side file is exported as a whole file.
 */
function planImportFile(
  state: State,
  selected: SelectedEntry,
  local: LocalFile,
  hydrated: readonly HydratedLayer[],
  label: string,
): void {
  const entry = selected.entry;
  const importName = entry.importName;
  if (importName === undefined) {
    const line = pushStatus(state, "ERROR", label, IMPORT_NAME_NOTE);
    recordStep(state, label, line, false);
    return;
  }

  const baseRepoPath = hydrated[0]?.layer.repoPath ?? label;
  const split = splitImport(
    local.bytes,
    hydrated.map((item) => ({
      label: item.layer.label,
      repoPath: item.layer.repoPath,
      bytes: item.bytes,
    })),
    importName,
  );
  const rules = entry.sanitize ?? [];
  const sanitized = rules.length > 0;
  const note = split.blockEdited ? IMPORT_BLOCK_NOTE : undefined;

  if (split.base === undefined) {
    pushStatus(state, "UNCHANGED", baseRepoPath, note);
  } else {
    const bytes = sanitized
      ? sanitize(split.base, rules, state.values, {
          json: entry.file.endsWith(".json"),
        })
      : split.base;
    state.pending = [];
    writeRepoFile(state, baseRepoPath, local, bytes, sanitized, note);
  }

  const separator = separatorFor(state.snapshot.os);
  const folder = parentDir(local.path, separator);
  for (const item of hydrated.slice(1)) {
    const repoPath = item.layer.repoPath;
    const sidePath = joinPath(
      folder,
      importName.replaceAll("{layer}", item.layer.label),
      separator,
    );
    const side = state.snapshot.localFiles.get(sidePath);
    if (side === undefined || side.kind !== "file") {
      // The snapshot reads an entry's own local path, not the layer files beside
      // it, so a side file it doesn't list has nothing to push: the layer file
      // stays as it is.
      pushStatus(state, "UNCHANGED", repoPath);
      continue;
    }
    if (state.isExcluded(sidePath)) {
      pushStatus(state, "SKIPPED", repoPath, EXCLUDE_NOTE);
      continue;
    }
    const bytes = sanitized
      ? sanitize(side.bytes, rules, state.values, {
          json: entry.file.endsWith(".json"),
        })
      : side.bytes;
    state.pending = [];
    writeRepoFile(state, repoPath, side, bytes, sanitized);
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

  const local = state.snapshot.localFiles.get(localPath);
  if (local === undefined || local.kind !== "file") {
    pushStatus(state, "SKIPPED", repoPath, `local file not found: ${localPath}`);
    state.skipped++;
    return;
  }

  if (entry.merge === "json" || entry.merge === "import") {
    const layers = hydratedLayers(state, selected, repoPath);
    if (layers === undefined) {
      return;
    }
    if (entry.merge === "json") {
      planJsonFile(state, selected, local, layers);
    } else {
      planImportFile(state, selected, local, layers, repoPath);
    }
    return;
  }

  const rules = entry.sanitize ?? [];
  const repo = state.snapshot.repoFiles.get(repoPath);

  if (rules.length > 0) {
    const sanitized = sanitize(local.bytes, rules, state.values, {
      json: entry.file.endsWith(".json"),
    });
    if (repo !== undefined) {
      if (same(repo, sanitized, compareOptions(state.snapshot, repoPath, true))) {
        pushStatus(state, "UNCHANGED", repoPath);
      } else {
        state.pending.push({
          action: { kind: "writeRepo", path: repoPath, bytes: sanitized },
          failure: WRITE_SANITIZED_FAILURE,
        });
        const line = pushStatus(state, "MODIFIED", repoPath, "sanitized");
        state.changed++;
        recordStep(state, repoPath, line, true);
      }
    } else {
      mkdirParent(state, repoPath);
      state.pending.push({
        action: { kind: "writeRepo", path: repoPath, bytes: sanitized },
        failure: WRITE_SANITIZED_FAILURE,
      });
      state.pending.push({
        action: { kind: "chmod", path: repoPath, mode: local.mode },
        failure: COPY_MODE_FAILURE,
      });
      const line = pushStatus(state, "ADDED", repoPath, "sanitized");
      state.changed++;
      recordStep(state, repoPath, line, true);
    }
    return;
  }

  if (repo === undefined) {
    mkdirParent(state, repoPath);
    state.pending.push({
      action: { kind: "writeRepo", path: repoPath, bytes: local.bytes },
      failure: COPY_TO_REPO_FAILURE,
    });
    state.pending.push({
      action: { kind: "chmod", path: repoPath, mode: local.mode },
      failure: COPY_MODE_FAILURE,
    });
    const line = pushStatus(state, "ADDED", repoPath);
    state.changed++;
    recordStep(state, repoPath, line, true);
    return;
  }

  if (same(repo, local.bytes, compareOptions(state.snapshot, repoPath, false))) {
    pushStatus(state, "UNCHANGED", repoPath);
    return;
  }

  state.pending.push({
    action: { kind: "writeRepo", path: repoPath, bytes: local.bytes },
    failure: COPY_TO_REPO_FAILURE,
  });
  state.pending.push({
    action: { kind: "chmod", path: repoPath, mode: local.mode },
    failure: COPY_MODE_FAILURE,
  });
  const line = pushStatus(state, "MODIFIED", repoPath);
  state.changed++;
  recordStep(state, repoPath, line, true);
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
    pushStatus(state, "SKIPPED", `${repoPath}/`, `local folder not found: ${localDir}`);
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
    const relative = localPath.slice(localPrefix.length).replaceAll(separator, "/");
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
    if (!onlySelected(label, state.only)) {
      continue;
    }
    const repo = state.snapshot.repoFiles.get(label);
    if (repo === undefined) {
      mkdirParent(state, label, CREATE_PARENT_FOLDER_FAILURE);
      state.pending.push({
        action: { kind: "writeRepo", path: label, bytes: local.bytes },
        failure: COPY_TO_REPO_FAILURE,
      });
      state.pending.push({
        action: { kind: "chmod", path: label, mode: local.mode },
        failure: COPY_MODE_FAILURE,
      });
      const line = pushStatus(state, "ADDED", label);
      state.changed++;
      recordStep(state, label, line, true);
    } else if (same(repo, local.bytes, compareOptions(state.snapshot, label, false))) {
      pushStatus(state, "UNCHANGED", label);
    } else {
      state.pending.push({
        action: { kind: "writeRepo", path: label, bytes: local.bytes },
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
    if (
      local !== undefined &&
      local.kind === "file" &&
      !state.isExcluded(localPath)
    ) {
      continue;
    }
    if (!onlySelected(repoName, state.only)) {
      continue;
    }
    state.pending.push({
      action: { kind: "removeRepo", path: repoName },
      failure: REMOVE_REPO_FAILURE,
    });
    const line = pushStatus(state, "REMOVED", repoName, "no longer in source");
    state.changed++;
    recordStep(state, repoName, line, true);
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

function rootsFor(config: ConfigV2, entry: ConfigV2Entry): readonly string[] {
  const os = entry.os ?? config.modules[entry.module]?.os ?? ALL_OS;
  return [BASE_ROOT, ...os.map((system) => `dotfiles/${system}/`)];
}

/** Contract "Orphan report": owned by an entry on any platform. */
function orphanReport(state: State): void {
  const exact = new Set<string>();
  const folders: string[] = [];
  const linked: string[] = [];

  for (const entry of state.snapshot.config.entries) {
    for (const root of rootsFor(state.snapshot.config, entry)) {
      const repoPath = `${root}${entry.file}`;
      if (entry.merge === "dir") {
        folders.push(`${repoPath}/`);
      } else {
        exact.add(repoPath);
      }
      if (entry.scanLinks === true) {
        linked.push(`${repoPath}.linked/`);
      }
    }
  }

  for (const path of [...state.snapshot.repoFiles.keys()].sort()) {
    // Profile and machine layer files live in the state folder, not the repo.
    if (!path.startsWith(REPO_TREE)) {
      continue;
    }
    const owned =
      exact.has(path) ||
      folders.some((prefix) => path.startsWith(prefix)) ||
      linked.some((prefix) => path.startsWith(prefix));
    if (!owned) {
      pushStatus(state, "ORPHAN", path, ORPHAN_NOTE);
    }
  }
}

/**
 * The export plan: every status line, action and the exit code the contract
 * gives export, from a snapshot and nothing else.
 */
export function planExport(snapshot: Snapshot): RunPlan {
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

  const rules: SanitizeRule[] = [];
  for (const entry of selected.value) {
    if (!entrySelected(entry, only.paths)) {
      continue;
    }
    if (entry.entry.merge === "dir" || entry.entry.merge === "dconf") {
      continue;
    }
    const localPath = resolvedLocal(entry.entry, snapshot.os, snapshot.home);
    const local = snapshot.localFiles.get(localPath);
    if (local?.kind === "file") {
      rules.push(...(entry.entry.sanitize ?? []));
    }
  }
  const values = resolveValues(rules, snapshot.values, {}, snapshot.env);
  if (!values.ok) {
    return errorPlan(values.error.message, 1);
  }

  const state: State = {
    snapshot,
    values: values.value,
    only: only.paths,
    isExcluded: compileExcludes(snapshot.config.excludePatterns ?? [], snapshot.os),
    steps: [],
    lines: [],
    pending: [],
    changed: 0,
    skipped: 0,
    hits: 0,
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

  if (only.paths.length === 0) {
    orphanReport(state);
  }

  const summary: ExportSummary = {
    kind: "export",
    onlyMatchedNothing: state.only.length > 0 && state.hits === 0,
    skipped: state.skipped,
  };
  return {
    // Bash saves every value whenever an entry with rules has a local file.
    prepare:
      rules.length > 0
        ? [{ kind: "writeValues", text: valuesFileText(values.value) }]
        : [],
    steps: state.steps,
    finish: [],
    lines: state.lines,
    summary,
    code: 0,
  };
}
