import {
  chmodSync,
  copyFileSync,
  lstatSync,
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
import type { ConfigV2, ConfigV2Entry, Os } from "../core/config/types.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { SelectedEntry } from "../core/layers/select.ts";
import type {
  Action,
  LocalEntry,
  LocalSymlink,
  Snapshot,
} from "../core/plan/types.ts";
import { formatLine } from "../core/status.ts";
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
  readonly home: string;
  readonly cwd: string;
  readonly values: Values;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly only: readonly string[];
  readonly force?: boolean;
}

/** What running a plan's actions needs to know: where the repo is and which OS paths follow. */
export interface RunContext {
  readonly repoRoot: string;
  readonly os: Os;
}

function pathFor(os: Os): PathApi {
  return os === "windows" ? win32 : posix;
}

/** lstat that treats an absent or unreadable path as absent. */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    // Unreadable or absent: the snapshot leaves it out and the plan reports it.
    return undefined;
  }
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

/** Contract "Orphan report": every file under `dotfiles/` is in the snapshot. */
function readRepoTree(
  dir: string,
  repoRoot: string,
  os: Os,
  files: Map<string, Uint8Array>,
): void {
  const entries = listDir(dir);
  if (entries === undefined) {
    return;
  }
  const p = pathFor(os);
  for (const entry of entries) {
    const path = p.join(dir, entry.name);
    if (entry.isDirectory()) {
      readRepoTree(path, repoRoot, os, files);
      continue;
    }
    const isFile = entry.isFile() || (entry.isSymbolicLink() && statOrUndefined(path)?.isFile() === true);
    if (!isFile) {
      continue;
    }
    const bytes = readBytes(path);
    if (bytes !== undefined) {
      files.set(repoKey(repoRoot, path, os), bytes);
    }
  }
}

function fileEntry(path: string, stats: Stats): LocalEntry | undefined {
  const bytes = readBytes(path);
  if (bytes === undefined) {
    return undefined;
  }
  return { kind: "file", path, bytes, mode: stats.mode & MODE_MASK };
}

/** Add one local file, or the symlink that stands in for it. */
function addLocalEntry(
  path: string,
  os: Os,
  localFiles: Map<string, LocalEntry>,
): void {
  const stats = lstatOrUndefined(path);
  if (stats === undefined) {
    return;
  }
  if (stats.isSymbolicLink()) {
    const symlink: LocalSymlink = { kind: "symlink", path };
    localFiles.set(path, symlink);
    return;
  }
  if (!stats.isFile()) {
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

function addExistingParent(
  path: string,
  os: Os,
  localDirs: Set<string>,
): void {
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
  const repoTree = pathFor(input.os).join(input.repoRoot, DOTFILES_FOLDER);
  readRepoTree(repoTree, input.repoRoot, input.os, repoFiles);

  const localFiles = new Map<string, LocalEntry>();
  const localDirs = new Set<string>();
  const selected = selectEntries(input.config, input.os, new Set(repoFiles.keys()));
  if (selected.ok) {
    for (const chosen of selected.value) {
      addSelectedEntry(chosen, input.os, input.home, localFiles, localDirs);
    }
  }

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
  };
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
}

/** An action's path is a repo path when it is relative to `dotfiles/`. */
function isRepoPath(path: string): boolean {
  return path === "dotfiles" || path.startsWith(REPO_PREFIX);
}

function absolutePath(path: string, context: RunContext): string {
  return isRepoPath(path)
    ? pathFor(context.os).join(context.repoRoot, path)
    : path;
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

/** Copy to `<file>.bak`, replacing an older one, with the mode and times (`cp -p`). */
function backupFile(path: string, os: Os): void {
  const stats = statSync(path);
  const backup = `${path}.bak`;
  copyFileSync(path, backup);
  if (os !== "windows") {
    chmodSync(backup, stats.mode & MODE_MASK);
  }
  utimesSync(backup, stats.atime, stats.mtime);
}

function writeStateFile(path: string, text: string, os: Os): void {
  mkdirSync(pathFor(os).dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? error.name : error.message;
  }
  return String(error);
}

const UNHANDLED_ACTION = "unhandled action";

/**
 * Run an action, returning the `ERROR` line it earns or nothing when it worked.
 * The action's path is the label, and the failure's message is the note.
 */
function runAction(action: Action, context: RunContext): string | undefined {
  try {
    switch (action.kind) {
      case "writeRepo":
        writeBytes(
          absolutePath(action.path, context),
          action.bytes,
          action.mode,
          context.os,
        );
        return undefined;
      case "removeRepo":
        rmSync(absolutePath(action.path, context), { force: true });
        return undefined;
      case "writeLocal":
        writeBytes(action.path, action.bytes, action.mode, context.os);
        return undefined;
      case "backup":
        backupFile(action.path, context.os);
        return undefined;
      case "mkdir":
        mkdirSync(absolutePath(action.path, context), { recursive: true });
        return undefined;
      case "chmod":
        if (context.os !== "windows") {
          chmodSync(absolutePath(action.path, context), action.mode);
        }
        return undefined;
      case "writeState":
        writeStateFile(action.path, action.text, context.os);
        return undefined;
      default: {
        const unhandled: never = action;
        throw new Error(`${UNHANDLED_ACTION}: ${String(unhandled)}`);
      }
    }
  } catch (error) {
    return formatLine("ERROR", action.path, errorReason(error));
  }
}

/**
 * Run a plan's actions in order (contract "Statuses", "Backups" and "Sync
 * point"). A failure affects only its own file: it becomes an `ERROR` line and
 * the next action still runs. Returns the lines produced; it never throws.
 */
export function runActions(
  actions: readonly Action[],
  context: RunContext,
): readonly string[] {
  const lines: string[] = [];
  for (const action of actions) {
    const line = runAction(action, context);
    if (line !== undefined) {
      lines.push(line);
    }
  }
  return lines;
}
