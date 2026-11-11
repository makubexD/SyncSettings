import type { ConfigV2, Os } from "../config/types.ts";
import type { Values } from "../values/sanitize.ts";

/**
 * A file under `dotfiles/`, keyed by its repo path in forward slashes, with the
 * bytes the snapshot read. The whole tree is present so the orphan report can
 * see files no entry owns.
 */
export type RepoFiles = ReadonlyMap<string, Uint8Array>;

/** A regular local file: what export reads and import writes. */
export interface LocalFile {
  readonly kind: "file";
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

/**
 * A local symlink. Directory entries report it as `SKIPPED (symlink)` and never
 * export it; no bytes are read.
 */
export interface LocalSymlink {
  readonly kind: "symlink";
  readonly path: string;
}

export type LocalEntry = LocalFile | LocalSymlink;

/**
 * Everything a plan may read, gathered by the adapters before the pure core
 * runs. Local paths are absolute in the OS's own form; repo paths always use
 * forward slashes.
 */
export interface Snapshot {
  readonly config: ConfigV2;
  readonly os: Os;
  /** The user's home folder, so a `~/` local path can be resolved. */
  readonly home: string;
  /** The caller's folder, for a `--only` path that is not absolute. */
  readonly cwd: string;
  readonly repoFiles: RepoFiles;
  /** Local files and symlinks, keyed by absolute path. */
  readonly localFiles: ReadonlyMap<string, LocalEntry>;
  /**
   * Local folders that exist, keyed by absolute path. Without it an empty
   * directory entry and a missing one would look alike.
   */
  readonly localDirs: ReadonlySet<string>;
  readonly values: Values;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Raw `--only` arguments, before they are resolved to repo paths. */
  readonly only: readonly string[];
}

/** Write bytes to a repo file. No `mode` keeps an existing target's mode. */
export interface WriteRepoAction {
  readonly kind: "writeRepo";
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode?: number;
}

/** Delete a repo file that a `dir` entry no longer holds locally. */
export interface RemoveRepoAction {
  readonly kind: "removeRepo";
  readonly path: string;
}

/** Write bytes to a local file (import). No `mode` keeps a target's mode. */
export interface WriteLocalAction {
  readonly kind: "writeLocal";
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode?: number;
}

/** Copy a local file's old contents to `<path>.bak` before it is replaced. */
export interface BackupAction {
  readonly kind: "backup";
  readonly path: string;
}

/** Create a folder and its parents when missing. */
export interface MkdirAction {
  readonly kind: "mkdir";
  readonly path: string;
}

/** Set a file's mode, as `cp -p` and `chmod --reference` do. */
export interface ChmodAction {
  readonly kind: "chmod";
  readonly path: string;
  readonly mode: number;
}

/** Write the sync point (contract "Sync point"). */
export interface WriteStateAction {
  readonly kind: "writeState";
  readonly path: string;
  readonly text: string;
}

export type Action =
  | WriteRepoAction
  | RemoveRepoAction
  | WriteLocalAction
  | BackupAction
  | MkdirAction
  | ChmodAction
  | WriteStateAction;

/** What a plan asks the adapter to do and print, and the exit code. */
export interface Plan {
  readonly actions: readonly Action[];
  readonly lines: readonly string[];
  readonly code: number;
}
