import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { posix, win32 } from "node:path";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, ConfigV2Entry, Os } from "../core/config/types.ts";
import { MACHINES_FOLDER, PROFILES_FOLDER } from "../core/guard.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { SelectedEntry } from "../core/layers/select.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { scopeFor } from "../core/plan/pick.ts";
import type {
  Action,
  LocalEntry,
  LocalSymlink,
  RunOutcome,
  RunPlan,
  Snapshot,
} from "../core/plan/types.ts";
import type { Values } from "../core/values/sanitize.ts";
import { expandHome } from "./paths.ts";

/** The parts of a path this OS writes: `posix` on Linux and macOS, `win32` on Windows. */
type PathApi = typeof posix;

const REPO_PREFIX = "dotfiles/";

const MODE_MASK = 0o7777;

const DOTFILES_FOLDER = "dotfiles";

/** Everything the snapshot adapter reads besides the disk itself. */
export interface SnapshotInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly os: Os;
  /** The sync point's folder, where a profile's or machine's layer files live. */
  readonly stateFolder?: string;
  readonly profile?: Profile;
  readonly machine?: string;
  readonly record?: MachineRecord;
  readonly home: string;
  readonly cwd: string;
  readonly values: Values;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly only: readonly string[];
  readonly force?: boolean;
}

/** What running a plan's steps needs to know: the repo, the OS, and the run's clock and folder. */
export interface RunContext {
  readonly repoRoot: string;
  readonly os: Os;
  /** The sync point's folder; dated backups sit under its `backups/`. */
  readonly stateFolder: string;
  /** The current time, so tests fix the dated backup's name. */
  readonly now: () => Date;
  readonly pid: number;
}

function pathFor(os: Os): PathApi {
  return os === "windows" ? win32 : posix;
}

/** stat that treats an absent or unreadable path as absent, following symlinks. */
function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function readBytes(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch {
    // An unreadable file is left out of the snapshot, so a plan reports it missing.
    return undefined;
  }
}

function listDir(path: string): readonly Dirent[] | undefined {
  try {
    return [...readdirSync(path, { withFileTypes: true })].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return undefined;
  }
}

function repoKey(repoRoot: string, path: string, os: Os): string {
  const separator = pathFor(os).sep;
  return pathFor(os).relative(repoRoot, path).split(separator).join("/");
}

/**
 * Read every file under `dir` into `files`, keyed by `keyOf(path, relative)`,
 * where `relative` is the path from `dir` joined with forward slashes. A
 * symlink to a file is followed, as `[[ -f ]]` does; other entries are skipped.
 */
function readTree(
  dir: string,
  os: Os,
  files: Map<string, Uint8Array>,
  keyOf: (path: string, relative: string) => string,
  prefix = "",
): void {
  const entries = listDir(dir);
  if (entries === undefined) {
    return;
  }
  const p = pathFor(os);
  for (const entry of entries) {
    const path = p.join(dir, entry.name);
    if (entry.isDirectory()) {
      readTree(path, os, files, keyOf, `${prefix}${entry.name}/`);
      continue;
    }
    const isFile =
      entry.isFile() ||
      (entry.isSymbolicLink() && statOrUndefined(path)?.isFile() === true);
    if (!isFile) {
      continue;
    }
    const bytes = readBytes(path);
    if (bytes !== undefined) {
      files.set(keyOf(path, `${prefix}${entry.name}`), bytes);
    }
  }
}

/** Contract "Orphan report": every file under `dotfiles/` is in the snapshot. */
function readRepoTree(
  dir: string,
  repoRoot: string,
  os: Os,
  files: Map<string, Uint8Array>,
): void {
  readTree(dir, os, files, (path) => repoKey(repoRoot, path, os));
}

/**
 * Contract "Profile and machine, until phase 6": a profile's or machine
 * layer's files join the snapshot under its layer path, so entry selection
 * sees them. Only the state folder is read, never the repo's `profiles/` or
 * `machines/` folders.
 */
function readStateTree(
  dir: string,
  prefix: string,
  os: Os,
  files: Map<string, Uint8Array>,
): void {
  readTree(dir, os, files, (_path, relative) => `${prefix}${relative}`);
}

function fileEntry(path: string, stats: Stats): LocalEntry | undefined {
  const bytes = readBytes(path);
  if (bytes === undefined) {
    return undefined;
  }
  return { kind: "file", path, bytes, mode: stats.mode & MODE_MASK };
}

/**
 * Add one file entry's local file. Like bash's `[[ -f ]]`, a symlink here is
 * followed: the snapshot holds the target's bytes and mode. A dangling link
 * is left out, so the plan reports the local file missing.
 */
function addLocalEntry(
  path: string,
  os: Os,
  localFiles: Map<string, LocalEntry>,
): void {
  const stats = statOrUndefined(path);
  if (stats === undefined || !stats.isFile()) {
    return;
  }
  const entry = fileEntry(path, stats);
  if (entry !== undefined) {
    localFiles.set(path, entry);
  }
}

/** Contract "Directory entries": recurse, recording symlinks without following them. */
function addLocalDir(
  dir: string,
  os: Os,
  localFiles: Map<string, LocalEntry>,
  localDirs: Set<string>,
): void {
  const root = statOrUndefined(dir);
  if (root === undefined || !root.isDirectory()) {
    return;
  }
  localDirs.add(dir);
  const entries = listDir(dir);
  if (entries === undefined) {
    return;
  }
  const p = pathFor(os);
  for (const entry of entries) {
    const path = p.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const symlink: LocalSymlink = { kind: "symlink", path };
      localFiles.set(path, symlink);
      continue;
    }
    if (entry.isDirectory()) {
      addLocalDir(path, os, localFiles, localDirs);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stats = statOrUndefined(path);
    if (stats === undefined) {
      continue;
    }
    const file = fileEntry(path, stats);
    if (file !== undefined) {
      localFiles.set(path, file);
    }
  }
}

function addExistingParent(path: string, os: Os, localDirs: Set<string>): void {
  const parent = pathFor(os).dirname(path);
  if (parent === path) {
    return;
  }
  const stats = statOrUndefined(parent);
  if (stats?.isDirectory() === true) {
    localDirs.add(parent);
  }
}

function localPathOf(
  entry: ConfigV2Entry,
  os: Os,
  home: string,
): string | undefined {
  const raw = entry.localPaths?.[os] ?? entry.localPath;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return expandHome(raw, os, home);
}

/**
 * Read the snapshot of contract "Entry selection" from disk: the local files and
 * folders the selected entries name, plus every repo file for the orphan report.
 * `HEAD`, the porcelain status and `HEAD`'s files belong to the git adapter, so
 * they stay unset here.
 */
export function readSnapshot(input: SnapshotInput): Snapshot {
  const repoFiles = new Map<string, Uint8Array>();
  const p = pathFor(input.os);
  const repoTree = p.join(input.repoRoot, DOTFILES_FOLDER);
  readRepoTree(repoTree, input.repoRoot, input.os, repoFiles);
  if (input.stateFolder !== undefined) {
    if (input.profile !== undefined) {
      const folder = `${PROFILES_FOLDER}/${input.profile.name}`;
      readStateTree(
        p.join(input.stateFolder, PROFILES_FOLDER, input.profile.name),
        `${folder}/`,
        input.os,
        repoFiles,
      );
    }
    if (input.machine !== undefined) {
      const folder = `${MACHINES_FOLDER}/${input.machine}`;
      readStateTree(
        p.join(input.stateFolder, MACHINES_FOLDER, input.machine),
        `${folder}/`,
        input.os,
        repoFiles,
      );
    }
  }

  const localFiles = new Map<string, LocalEntry>();
  const localDirs = new Set<string>();
  // The snapshot is built first so the selection can read the same scope a
  // plan will; the maps it holds are filled below.
  const snapshot: Snapshot = {
    config: input.config,
    os: input.os,
    home: input.home,
    cwd: input.cwd,
    repoFiles,
    localFiles,
    localDirs,
    values: input.values,
    env: input.env,
    only: input.only,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.machine !== undefined ? { machine: input.machine } : {}),
    ...(input.record !== undefined ? { record: input.record } : {}),
  };
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(repoFiles.keys()),
  );
  if (selected.ok) {
    for (const chosen of selected.value) {
      addSelectedEntry(chosen, input.os, input.home, localFiles, localDirs);
    }
  }

  if (input.force !== undefined) {
    return { ...snapshot, force: input.force };
  }
  return snapshot;
}

function addSelectedEntry(
  selected: SelectedEntry,
  os: Os,
  home: string,
  localFiles: Map<string, LocalEntry>,
  localDirs: Set<string>,
): void {
  const entry = selected.entry;
  if (entry.merge === "dconf") {
    return;
  }
  const path = localPathOf(entry, os, home);
  if (path === undefined) {
    return;
  }
  if (entry.merge === "dir") {
    addLocalDir(path, os, localFiles, localDirs);
    return;
  }
  addLocalEntry(path, os, localFiles);
  if (localFiles.has(path)) {
    addExistingParent(path, os, localDirs);
  }
  addImportSideFiles(selected, path, os, localFiles);
}

/**
 * Contract "Layers (program only)": an `import` entry's later layers each have
 * a side file beside the local file. Pull compares and backs them up, and push
 * exports them, so the snapshot reads them like the local file.
 */
function addImportSideFiles(
  selected: SelectedEntry,
  path: string,
  os: Os,
  localFiles: Map<string, LocalEntry>,
): void {
  const importName = selected.entry.importName;
  if (selected.entry.merge !== "import" || importName === undefined) {
    return;
  }
  const p = pathFor(os);
  const folder = p.dirname(path);
  for (const layer of selected.layers.slice(1)) {
    addLocalEntry(
      p.join(folder, importName.replaceAll("{layer}", layer.label)),
      os,
      localFiles,
    );
  }
}

/** An action's path is a repo path when it is relative to `dotfiles/`. */
function isRepoPath(path: string): boolean {
  return path === "dotfiles" || path.startsWith(REPO_PREFIX);
}

/** An action's path is a state path when it names a profile or machine layer. */
function isStatePath(path: string): boolean {
  return (
    path.startsWith(`${PROFILES_FOLDER}/`) ||
    path.startsWith(`${MACHINES_FOLDER}/`)
  );
}

/** A repo path stays under `dotfiles/`: its first segment. */
const REPO_CONTAINMENT_DEPTH = 1;

/** A state path stays under `profiles/<name>/` or `machines/<name>/`: two segments. */
const STATE_CONTAINMENT_DEPTH = 2;

/**
 * `path` resolved under `root`, after normalizing its `.` and `..` segments,
 * and contained to `base` (a resolved folder under `root`). Throws when it
 * lands outside `base`, so a `..` segment cannot reach past the folder `base`
 * names.
 */
function containedUnder(
  base: string,
  root: string,
  path: string,
  p: PathApi,
): string {
  const resolved = p.resolve(root, path);
  const relative = p.relative(base, resolved);
  if (relative === "") {
    return resolved;
  }
  if (
    relative === ".." ||
    relative.startsWith(`..${p.sep}`) ||
    p.isAbsolute(relative)
  ) {
    throw new Error(`path escapes its root: ${path}`);
  }
  return resolved;
}

/**
 * `path` resolved under `root`, contained to the folder its first `depth`
 * segments name: `dotfiles/` for a repo path, `profiles/<name>/` or
 * `machines/<name>/` for a state path. A `..` segment cannot reach past that
 * folder, so an entry cannot write into another layer, another profile, or
 * `backups/` (contract "Layers (program only)").
 */
function containedPath(
  path: string,
  root: string,
  depth: number,
  context: RunContext,
): string {
  const p = pathFor(context.os);
  const base = p.resolve(root, ...path.split("/").slice(0, depth));
  return containedUnder(base, root, path, p);
}

/**
 * Where an action writes: a repo path under the repo's `dotfiles/`, a profile
 * or machine layer path under that layer's folder in the state folder, and
 * anything else as an absolute local path. A repo or state path that resolves
 * outside its folder throws, failing the action.
 */
function absolutePath(path: string, context: RunContext): string {
  if (isRepoPath(path)) {
    return containedPath(
      path,
      context.repoRoot,
      REPO_CONTAINMENT_DEPTH,
      context,
    );
  }
  if (isStatePath(path)) {
    return containedPath(
      path,
      context.stateFolder,
      STATE_CONTAINMENT_DEPTH,
      context,
    );
  }
  return path;
}

function existingMode(path: string): number | undefined {
  const stats = statOrUndefined(path);
  return stats === undefined ? undefined : stats.mode & MODE_MASK;
}

/**
 * Write bytes, keeping an existing target's mode (`chmod --reference`) when the
 * action names none. Modes are skipped on Windows.
 */
function writeBytes(
  path: string,
  bytes: Uint8Array,
  mode: number | undefined,
  os: Os,
): void {
  const reference = os === "windows" ? undefined : existingMode(path);
  writeFileSync(path, bytes);
  if (os === "windows") {
    return;
  }
  const target = mode ?? reference;
  if (target !== undefined) {
    chmodSync(path, target);
  }
}

/** Copy a file keeping its mode and times, as `cp -p` does. */
function copyPreserving(source: string, target: string, os: Os): void {
  const stats = statSync(source);
  copyFileSync(source, target);
  if (os !== "windows") {
    chmodSync(target, stats.mode & MODE_MASK);
  }
  utimesSync(target, stats.atime, stats.mtime);
}

/** Copy to `<file>.bak`, replacing an older one, with the mode and times (`cp -p`). */
function backupFile(path: string, os: Os): void {
  copyPreserving(path, `${path}.bak`, os);
}

function writeStateFile(path: string, text: string, os: Os): void {
  mkdirSync(pathFor(os).dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const VALUES_FILE = ".user-values.json";

/** Values are secrets: readable by the user only (contract "Where values come from"). */
const PRIVATE_MODE = 0o600;

/**
 * Save `.user-values.json` in the repo. An existing file is tightened before
 * the write, so new values never sit in a readable file.
 */
function writeValuesFile(text: string, context: RunContext): void {
  const path = pathFor(context.os).join(context.repoRoot, VALUES_FILE);
  if (context.os === "windows") {
    // shortcut: the Windows ACL (no inherited access) comes with the Windows
    // adapter; see the design's "Confirm on Windows".
    writeFileSync(path, text);
    return;
  }
  if (existingMode(path) !== undefined) {
    chmodSync(path, PRIVATE_MODE);
  }
  writeFileSync(path, text, { mode: PRIVATE_MODE });
  chmodSync(path, PRIVATE_MODE);
}

const UNHANDLED_ACTION = "unhandled action";

const BACKUPS_FOLDER = "backups";

/** How many run folders `backups/` keeps, newest by name (contract "Backups"). */
const KEPT_BACKUP_RUNS = 20;

const DATED_BACKUP_WARNING = "  WARNING: could not keep a dated backup of";

/** The dated backups one run makes: its folder, computed at the first copy, and whether one landed. */
interface DatedBackups {
  folder: string | undefined;
  made: boolean;
}

/** What one action did: whether it worked, and the warning it printed when it only warned. */
interface ActionRun {
  readonly ok: boolean;
  readonly warning: string | undefined;
}

const ACTION_OK: ActionRun = { ok: true, warning: undefined };

/** `<run>` in contract "Backups": `YYYYMMDD-HHMMSS-<pid>` in local time. */
function runFolderName(at: Date, pid: number): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${date}-${time}-${pid}`;
}

/**
 * Copy a file into this run's folder under `backups/`, keeping its mode and
 * times. A `repoPath` that would land outside the run folder fails the dated
 * copy. A failure only warns (contract "Backups"): the `.bak` is the backup
 * that must succeed.
 */
function datedBackup(
  source: string,
  repoPath: string,
  context: RunContext,
  dated: DatedBackups,
): string | undefined {
  const p = pathFor(context.os);
  try {
    dated.folder ??= p.join(
      context.stateFolder,
      BACKUPS_FOLDER,
      runFolderName(context.now(), context.pid),
    );
    const destination = containedUnder(dated.folder, dated.folder, repoPath, p);
    mkdirSync(p.dirname(destination), { recursive: true });
    copyPreserving(source, destination, context.os);
    dated.made = true;
    return undefined;
  } catch {
    // By contract a failed dated copy warns and the run goes on.
    return `${DATED_BACKUP_WARNING} ${repoPath}.`;
  }
}

/**
 * Contract "Writes to the state folder": before a write or remove replaces a
 * profile or machine layer file, the old file goes into the run's dated
 * folder. A missing file needs no copy.
 */
function datedBackupOfStateFile(
  path: string,
  repoPath: string,
  context: RunContext,
  dated: DatedBackups,
): string | undefined {
  if (!isStatePath(repoPath) || statOrUndefined(path)?.isFile() !== true) {
    return undefined;
  }
  return datedBackup(path, repoPath, context, dated);
}

/** Apply `cp -p`'s mode from the repo file a created local file copies (not on Windows). */
function copyModeFrom(
  path: string,
  modeFrom: string | undefined,
  context: RunContext,
): void {
  if (context.os === "windows" || modeFrom === undefined) {
    return;
  }
  const mode = existingMode(
    pathFor(context.os).join(context.repoRoot, modeFrom),
  );
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

/** Remove every run folder beyond the newest `KEPT_BACKUP_RUNS`, sorted by name. */
function pruneBackups(context: RunContext): void {
  const root = pathFor(context.os).join(context.stateFolder, BACKUPS_FOLDER);
  const entries = listDir(root);
  if (entries === undefined) {
    return;
  }
  const runs = entries.filter((entry) => entry.isDirectory());
  const excess = runs.length - KEPT_BACKUP_RUNS;
  for (let index = 0; index < excess; index += 1) {
    const run = runs[index];
    if (run !== undefined) {
      rmSync(pathFor(context.os).join(root, run.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

/** Run one action, returning what it did; it never throws. */
function runAction(
  action: Action,
  context: RunContext,
  dated: DatedBackups,
): ActionRun {
  try {
    switch (action.kind) {
      case "writeRepo": {
        const path = absolutePath(action.path, context);
        const warning = datedBackupOfStateFile(
          path,
          action.path,
          context,
          dated,
        );
        writeBytes(path, action.bytes, action.mode, context.os);
        return { ok: true, warning };
      }
      case "removeRepo": {
        const path = absolutePath(action.path, context);
        const warning = datedBackupOfStateFile(
          path,
          action.path,
          context,
          dated,
        );
        rmSync(path, { force: true });
        return { ok: true, warning };
      }
      case "writeLocal":
        writeBytes(action.path, action.bytes, action.mode, context.os);
        copyModeFrom(action.path, action.modeFrom, context);
        return ACTION_OK;
      case "backup": {
        backupFile(action.path, context.os);
        if (action.repoPath === undefined) {
          return ACTION_OK;
        }
        const warning = datedBackup(
          action.path,
          action.repoPath,
          context,
          dated,
        );
        return { ok: true, warning };
      }
      case "mkdir":
        mkdirSync(absolutePath(action.path, context), { recursive: true });
        return ACTION_OK;
      case "chmod":
        if (context.os !== "windows") {
          chmodSync(absolutePath(action.path, context), action.mode);
        }
        return ACTION_OK;
      case "writeState":
        writeStateFile(action.path, action.text, context.os);
        return ACTION_OK;
      case "writeValues":
        writeValuesFile(action.text, context);
        return ACTION_OK;
      default: {
        const unhandled: never = action;
        throw new Error(`${UNHANDLED_ACTION}: ${String(unhandled)}`);
      }
    }
  } catch {
    // The plan gives each action the contract's reason, so only success matters here.
    return { ok: false, warning: undefined };
  }
}

/**
 * Run a plan's steps in order (contract "Statuses", "Backups" and "Sync point").
 * A step stops at its first failed action, recording that action's failure; the
 * next step still runs. `finish` runs only when no step failed. After a run
 * that made a dated copy, `backups/` keeps its newest 20 run folders. Returns
 * the failures and warnings keyed by step index, and the run's folder when a
 * copy landed; it never throws.
 */
export function runPlan(plan: RunPlan, context: RunContext): RunOutcome {
  const failed = new Map<number, string>();
  const warnings = new Map<number, readonly string[]>();
  const dated: DatedBackups = { folder: undefined, made: false };

  // shortcut: a failed values save is not reported yet; the contract names no
  // status for it, so it goes in the design's "Open" list.
  for (const action of plan.prepare ?? []) {
    runAction(action, context, dated);
  }

  plan.steps.forEach((step, index) => {
    const stepWarnings: string[] = [];
    for (const stepAction of step.actions) {
      const result = runAction(stepAction.action, context, dated);
      if (result.warning !== undefined) {
        stepWarnings.push(result.warning);
      }
      if (!result.ok) {
        failed.set(index, stepAction.failure);
        break;
      }
    }
    if (stepWarnings.length > 0) {
      warnings.set(index, stepWarnings);
    }
  });

  if (failed.size === 0) {
    for (const action of plan.finish) {
      runAction(action, context, dated);
    }
  }

  if (dated.made) {
    pruneBackups(context);
  }

  const outcome: RunOutcome = { failed, warnings };
  if (dated.made && dated.folder !== undefined) {
    return { ...outcome, backups: dated.folder };
  }
  return outcome;
}
