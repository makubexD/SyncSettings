import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { join, posix, relative, sep, win32 } from "node:path";
import type { Profile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
} from "../core/config/types.ts";
import {
  MACHINES_FOLDER,
  PROFILES_FOLDER,
  STATE_FOLDER_ROOTS,
} from "../core/guard.ts";
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
import { SymlinkRefusal, writeAtomic } from "./atomic.ts";
import { dconfLoad } from "./dconf.ts";
import { expandHome } from "./paths.ts";
import { writeStoreProfile, writeStoreRecord } from "./store.ts";
import type { StoreLocation } from "./store.ts";

/** The parts of a path this OS writes: `posix` on Linux and macOS, `win32` on Windows. */
type PathApi = typeof posix;

const REPO_PREFIX = "dotfiles/";

const MODE_MASK = 0o7777;

const DOTFILES_FOLDER = "dotfiles";

/** The config file the contract's unsafe path message names, v1 or v2. */
const CONFIG_FILE = "sync-config.json";

/** Everything the snapshot adapter reads besides the disk itself. */
export interface SnapshotInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly os: Os;
  /** The store the run's record, profile and layer files live in. */
  readonly location?: StoreLocation;
  readonly profile?: Profile;
  readonly machine?: string;
  readonly record?: MachineRecord;
  readonly home: string;
  readonly cwd: string;
  readonly values: Values;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly only: readonly string[];
  readonly skip?: readonly string[];
  readonly force?: boolean;
}

/** What running a plan's steps needs to know: the repo, the OS, and the run's clock and folder. */
export interface RunContext {
  readonly repoRoot: string;
  readonly os: Os;
  /** The sync point's folder; dated backups sit under its `backups/`. */
  readonly stateFolder: string;
  /** The store the run's record, profile and layer files live in. */
  readonly location: StoreLocation;
  /** The environment the snapshot used; the tools a step runs see it too. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The current time, so tests fix the dated backup's name. */
  readonly now: () => Date;
  readonly pid: number;
}

function pathFor(os: Os): PathApi {
  return os === "windows" ? win32 : posix;
}

/**
 * The base folder a store's layer folders sit under: the parent of its
 * profiles folder. That is the state folder for a local store and the clone
 * for a pointer (contract "Where records are kept").
 */
function storeRoot(location: StoreLocation, os: Os): string {
  return pathFor(os).dirname(location.profilesFolder);
}

/** stat that treats an absent or unreadable path as absent, following symlinks. */
function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** A file's bytes, or undefined when it cannot be read. */
function readBytes(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch {
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
 * symlink to a file is followed when `followSymlinks` is set, as `[[ -f ]]`
 * does; the repo read leaves links out, since nothing under `dotfiles/` may be
 * one (contract "Path safety"). Other entries are skipped.
 */
function readTree(
  dir: string,
  os: Os,
  files: Map<string, Uint8Array>,
  keyOf: (path: string, relative: string) => string,
  followSymlinks: boolean,
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
      readTree(
        path,
        os,
        files,
        keyOf,
        followSymlinks,
        `${prefix}${entry.name}/`,
      );
      continue;
    }
    const isFile =
      entry.isFile() ||
      (followSymlinks &&
        entry.isSymbolicLink() &&
        statOrUndefined(path)?.isFile() === true);
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
  readTree(dir, os, files, (path) => repoKey(repoRoot, path, os), false);
}

/**
 * Contract "Profile and machine, until phase 6": a profile's or machine
 * layer's files join the snapshot under its layer path, so entry selection
 * sees them. Only the store's layer folders are read: the state folder's, or
 * the clone's with a pointer.
 */
function readStateTree(
  dir: string,
  prefix: string,
  os: Os,
  files: Map<string, Uint8Array>,
): void {
  readTree(dir, os, files, (_path, relative) => `${prefix}${relative}`, true);
}

function unsafePathMessage(name: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${name} has an unsafe path.`;
}

/**
 * The first symlink under `dir`, sorted by name, or undefined. The entries come
 * from `readdirSync` with their own types, so a symlinked folder is named and
 * never entered.
 */
function firstSymlink(dir: string): string | undefined {
  const entries = listDir(dir);
  if (entries === undefined) {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      return path;
    }
    if (entry.isDirectory()) {
      const found = firstSymlink(path);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * The name the unsafe path message gives a symlink: the repo path of the entry
 * that owns it, or the symlink's own repo-relative path when none does
 * (contract "Path safety").
 */
function symlinkName(link: string, config: ConfigV2): string {
  for (const entry of config.entries) {
    const file = entry.file;
    if (link.endsWith(`/${file}`)) {
      return link;
    }
    const folder = link.indexOf(`/${file}/`);
    if (entry.merge === "dir" && folder !== -1) {
      return link.slice(0, folder + file.length + 1);
    }
    const linked = link.indexOf(`/${file}.linked/`);
    if (entry.merge !== "dir" && entry.merge !== "dconf" && linked !== -1) {
      return link.slice(0, linked + file.length + 1);
    }
  }
  return link;
}

/**
 * Contract "Path safety": nothing under `dotfiles/` is a symlink. Returns the
 * error naming the first one, sorted by name, so a run stops before it touches
 * a file. A repo with no `dotfiles/` folder has none.
 */
export function findRepoSymlink(
  repoRoot: string,
  config: ConfigV2,
): ConfigError | undefined {
  const path = firstSymlink(join(repoRoot, DOTFILES_FOLDER));
  if (path === undefined) {
    return undefined;
  }
  const link = relative(repoRoot, path).split(sep).join("/");
  return { message: unsafePathMessage(symlinkName(link, config)), code: 1 };
}

/**
 * A local file's bytes and mode. A file that exists but cannot be read keeps
 * its own kind, so a plan prints `ERROR <label> cannot read local file` rather
 * than treating it as a changed or missing file.
 */
function fileEntry(path: string, stats: Stats): LocalEntry {
  const bytes = readBytes(path);
  if (bytes === undefined) {
    return { kind: "unreadable", path };
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
  localFiles.set(path, fileEntry(path, stats));
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
    localFiles.set(path, fileEntry(path, stats));
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
  if (input.location !== undefined) {
    if (input.profile !== undefined) {
      const folder = `${PROFILES_FOLDER}/${input.profile.name}`;
      readStateTree(
        p.join(input.location.profilesFolder, input.profile.name),
        `${folder}/`,
        input.os,
        repoFiles,
      );
    }
    if (input.machine !== undefined) {
      const folder = `${MACHINES_FOLDER}/${input.machine}`;
      readStateTree(
        p.join(
          storeRoot(input.location, input.os),
          MACHINES_FOLDER,
          input.machine,
        ),
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
    ...(input.skip !== undefined ? { skip: input.skip } : {}),
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
  return STATE_FOLDER_ROOTS.some((root) => path.startsWith(root));
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
 * or machine layer path under that layer's folder in the run's store (the
 * state folder, or the clone with a pointer), and anything else as an
 * absolute local path. A repo or state path that resolves outside its folder
 * throws, failing the action.
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
      storeRoot(context.location, context.os),
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
 * Write bytes to a local file, keeping an existing target's mode
 * (`chmod --reference`) when the action names none. A local path is written in
 * place, following a symlink, as people link their dotfiles. Modes are skipped
 * on Windows.
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

/** A new file's mode before the umask, as a plain write creates it. */
const NEW_FILE_MODE = 0o666;

/**
 * Write a repo file atomically: the bytes go to a temp file in the same folder
 * and are renamed over the target, so a crash leaves the old file whole. The
 * mode is the action's, else the replaced file's, else the umask's for a new
 * file, as the old engines and the shared cases have it. A symlinked path is
 * refused rather than followed (contract "Where records are kept").
 */
function writeRepoFile(
  path: string,
  bytes: Uint8Array,
  mode: number | undefined,
): void {
  const target =
    mode ?? existingMode(path) ?? NEW_FILE_MODE & ~process.umask();
  writeAtomic(path, bytes, target);
}

/**
 * Write a state file (the sync point, a dconf backup) atomically. These hold
 * no secrets, so the file keeps its mode, or a new one gets the umask's, as the
 * old engines and the shared cases have it; values, records and profiles are
 * the 0600 files. A symlinked path is refused rather than followed (contract
 * "Where records are kept").
 */
function writeStateFile(path: string, text: string, os: Os): void {
  mkdirSync(pathFor(os).dirname(path), { recursive: true });
  const mode = existingMode(path) ?? NEW_FILE_MODE & ~process.umask();
  writeAtomic(path, text, mode);
}

const VALUES_FILE = ".user-values.json";

/** Values are secrets: readable by the user only (contract "Where values come from"). */
const PRIVATE_MODE = 0o600;

/**
 * Save `.user-values.json` in the repo atomically and for the current user
 * only, so new values never sit in a readable file and a crash leaves the old
 * one whole. A symlinked path is refused rather than followed.
 */
function writeValuesFile(text: string, context: RunContext): void {
  const path = pathFor(context.os).join(context.repoRoot, VALUES_FILE);
  writeAtomic(path, text, PRIVATE_MODE);
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

/** What one action did: whether it worked, the warning it printed when it only
 * warned, and the contract line a refused symlink stopped it with. */
interface ActionRun {
  readonly ok: boolean;
  readonly warning: string | undefined;
  readonly refusal?: string;
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

/** What one dated state backup did: the run folder it used and the warning a
 * failed copy printed, which only warns (contract "Backups"). */
export interface StateBackup {
  readonly folder: string;
  readonly warning?: string;
}

/**
 * Contract "Writes to the state folder": copy a state file into a run's dated
 * backup folder. `runFolder` names a folder the plan already made, so both
 * copies share it; without one, the folder is named and `backups/` pruned as a
 * run's would be. A failed copy only warns.
 */
export function backupStateFile(
  source: string,
  repoPath: string,
  context: RunContext,
  runFolder?: string,
): StateBackup {
  const created = runFolder === undefined;
  const folder =
    runFolder ??
    pathFor(context.os).join(
      context.stateFolder,
      BACKUPS_FOLDER,
      runFolderName(context.now(), context.pid),
    );
  const dated: DatedBackups = { folder, made: false };
  const warning = datedBackup(source, repoPath, context, dated);
  if (created && dated.made) {
    pruneBackups(context);
  }
  return warning === undefined ? { folder } : { folder, warning };
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

/**
 * Remove the folders a `REMOVED` file leaves empty, walking up from the file's
 * folder and stopping before `stop`, which is never removed. A folder outside
 * `stop`, a folder still holding an entry, and a folder that cannot be removed
 * each end the walk silently, as bash's `find … -empty -delete` does.
 */
function pruneEmptyFolders(folder: string, stop: string, os: Os): void {
  const p = pathFor(os);
  const root = p.resolve(stop);
  let current = p.resolve(folder);
  for (;;) {
    const relative = p.relative(root, current);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${p.sep}`) ||
      p.isAbsolute(relative)
    ) {
      return;
    }
    const entries = listDir(current);
    if (entries === undefined || entries.length > 0) {
      return;
    }
    try {
      rmdirSync(current);
    } catch {
      // A folder that cannot be removed is left, as bash ignores the failure.
      return;
    }
    current = p.dirname(current);
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
        writeRepoFile(path, action.bytes, action.mode);
        return { ok: true, warning };
      }
      case "removeRepo": {
        const path = absolutePath(action.path, context);
        const pruneUpTo =
          action.pruneUpTo === undefined
            ? undefined
            : absolutePath(action.pruneUpTo, context);
        const warning = datedBackupOfStateFile(
          path,
          action.path,
          context,
          dated,
        );
        rmSync(path, { force: true });
        if (pruneUpTo !== undefined) {
          pruneEmptyFolders(
            pathFor(context.os).dirname(path),
            pruneUpTo,
            context.os,
          );
        }
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
      case "writeState": {
        writeStateFile(action.path, action.text, context.os);
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
      case "dconfLoad":
        // Any failure, a missing dconf too, is the contract's `dconf load failed`.
        return dconfLoad(action.path, action.text, context.env).kind === "ok"
          ? ACTION_OK
          : { ok: false, warning: undefined };
      case "writeValues":
        writeValuesFile(action.text, context);
        return ACTION_OK;
      case "writeMachineValues":
        if (action.profile !== undefined) {
          writeStoreProfile(context.location, action.profile);
        }
        writeStoreRecord(context.location, action.record);
        return ACTION_OK;
      default: {
        const unhandled: never = action;
        throw new Error(`${UNHANDLED_ACTION}: ${String(unhandled)}`);
      }
    }
  } catch (error) {
    if (error instanceof SymlinkRefusal) {
      // A symlinked state or repo path is refused, not followed (contract
      // "Where records are kept"); its own line is the run's error.
      return { ok: false, warning: undefined, refusal: error.message };
    }
    // The plan gives each action the contract's reason, so only success matters here.
    return { ok: false, warning: undefined };
  }
}

/**
 * What `runPlan` returns: the run's outcome plus the `finish` actions that
 * failed and the line a refused symlink stopped the run with. The import turns
 * a failed `writeState` into the sync point warning (contract "Sync point");
 * the rest of the outcome is unchanged.
 */
export interface RunPlanOutcome extends RunOutcome {
  readonly failedFinish: readonly Action[];
  readonly refused: string | undefined;
}

/**
 * Run a plan's steps in order (contract "Statuses", "Backups" and "Sync point").
 * A step stops at its first failed action, recording that action's failure; the
 * next step still runs. A refusal (`SymlinkRefusal`) stops the whole run where
 * it happens, in a `prepare`, step or `finish` action, and no further action
 * runs. `finish` runs only when no step failed. After a run that made a dated
 * copy, `backups/` keeps its newest 20 run folders. Returns the failures and
 * warnings keyed by step index, the `finish` actions that failed, the run's
 * folder when a copy landed, and the refusal line when a symlink stopped it; it
 * never throws.
 */
export function runPlan(plan: RunPlan, context: RunContext): RunPlanOutcome {
  const failed = new Map<number, string>();
  const warnings = new Map<number, readonly string[]>();
  const failedFinish: Action[] = [];
  const dated: DatedBackups = { folder: undefined, made: false };
  let refused: string | undefined;

  for (const action of plan.prepare ?? []) {
    const result = runAction(action, context, dated);
    if (result.refusal !== undefined) {
      refused = result.refusal;
      break;
    }
  }

  if (refused === undefined) {
    steps: for (const [index, step] of plan.steps.entries()) {
      const stepWarnings: string[] = [];
      for (const stepAction of step.actions) {
        const result = runAction(stepAction.action, context, dated);
        if (result.warning !== undefined) {
          stepWarnings.push(result.warning);
        }
        if (!result.ok) {
          if (result.refusal !== undefined) {
            refused = result.refusal;
            break steps;
          }
          failed.set(index, stepAction.failure);
          break;
        }
      }
      if (stepWarnings.length > 0) {
        warnings.set(index, stepWarnings);
      }
    }
  }

  if (failed.size === 0 && refused === undefined) {
    for (const action of plan.finish) {
      const result = runAction(action, context, dated);
      if (result.refusal !== undefined) {
        refused = result.refusal;
        break;
      }
      if (!result.ok) {
        failedFinish.push(action);
      }
    }
  }

  if (dated.made) {
    pruneBackups(context);
  }

  const outcome: RunPlanOutcome = { failed, warnings, failedFinish, refused };
  if (dated.made && dated.folder !== undefined) {
    return { ...outcome, backups: dated.folder };
  }
  return outcome;
}
