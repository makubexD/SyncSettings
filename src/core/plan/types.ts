import type { Profile } from "../config/profile.ts";
import type { ConfigV2, Os } from "../config/types.ts";
import type { LayerName } from "../layers/select.ts";
import type { MachineRecord } from "../machine/record.ts";
import type { Values } from "../values/sanitize.ts";

/**
 * One line of the push preview or the import check: the layer the change is
 * written to, the kind, the module and file labels, and what changed. The
 * adapter numbers and pads the lines (contract "Push preview (program only)").
 */
export interface ChangeLine {
  readonly layer: LayerName;
  readonly kind: "M" | "+" | "-";
  readonly module: string;
  readonly file: string;
  readonly what: string;
}

/**
 * One new setting the plan can't route: a json key or an array item with no
 * destination (contract "New settings (program only)"). The adapter asks where
 * it goes; the core only names it. `file` is the entry's file without its first
 * folder, as a change line's is; `what` is `<path>: <value>`, the value
 * compact, sanitized and cut as a change line's.
 */
export interface NewSettingLine {
  readonly module: string;
  readonly file: string;
  readonly path: string;
  readonly kind: "key" | "item";
  readonly what: string;
}

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
  /** Contract "Layers (program only)": the profile layer this run uses. */
  readonly profile?: Profile;
  /** Contract "Layers (program only)": the machine layer this run uses. */
  readonly machine?: string;
  /** Contract "Where records are kept": the record this run reads. */
  readonly record?: MachineRecord;
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
  /** `--force`: overwrite without asking. Never skips the `.bak` backup. */
  readonly force?: boolean;
  /** The repo's `HEAD` SHA, when it resolves; absent when it does not. */
  readonly head?: string;
  /**
   * The repo files' bytes at `HEAD`, when a commit exists; absent when it does
   * not. An export preview compares its result with these to say whether
   * anything would be sent.
   */
  readonly headFiles?: RepoFiles;
  /**
   * Raw `git status --porcelain -- dotfiles sync-config.json` output. An empty
   * string is a clean tree; absent means git could not tell.
   */
  readonly porcelain?: string;
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
  /** A repo path whose mode a created file copies (`cp -p`). */
  readonly modeFrom?: string;
}

/** Copy a local file's old contents to `<path>.bak` before it is replaced. */
export interface BackupAction {
  readonly kind: "backup";
  readonly path: string;
  /** Where the dated copy goes under the state folder's `backups/`. */
  readonly repoPath?: string;
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

/**
 * Save `.user-values.json` next to the config, readable by the user only
 * (contract "Where values come from").
 */
export interface WriteValuesAction {
  readonly kind: "writeValues";
  readonly text: string;
}

/**
 * Save a record's and profile's values in the state folder (contract "Values
 * on a machine"). The record and profile carry the values new this run already
 * merged in; the core does the merge, the adapter only writes.
 */
export interface WriteMachineValuesAction {
  readonly kind: "writeMachineValues";
  readonly record: MachineRecord;
  readonly profile?: Profile;
}

export type Action =
  | WriteRepoAction
  | RemoveRepoAction
  | WriteLocalAction
  | BackupAction
  | MkdirAction
  | ChmodAction
  | WriteStateAction
  | WriteValuesAction
  | WriteMachineValuesAction;

/** What a plan asks the adapter to do and print, and the exit code. */
export interface Plan {
  readonly actions: readonly Action[];
  readonly lines: readonly string[];
  readonly code: number;
}

/** One action of a file's step and the contract's reason when it fails. */
export interface StepAction {
  readonly action: Action;
  readonly failure: string;
}

/**
 * One file's actions, grouped with the status line the plan prints for it.
 * `line` is the index of that line in `RunPlan.lines`; `counted` means the
 * file counts towards the summary's count.
 */
export interface FileStep {
  readonly label: string;
  readonly line: number;
  readonly counted: boolean;
  readonly actions: readonly StepAction[];
}

/** What `import.ts`'s `summaryLines` reads besides the count. */
export interface ImportSummary {
  readonly kind: "import";
  readonly onlyMatchedNothing: boolean;
  readonly syncPoint?: string;
}

/** What `export.ts`'s `summaryLines` reads besides the count. */
export interface ExportSummary {
  readonly kind: "export";
  readonly onlyMatchedNothing: boolean;
  readonly skipped: number;
}

/** A plan whose lines are all there is: an early error prints no summary. */
export interface NoSummary {
  readonly kind: "none";
}

export type Summary = ImportSummary | ExportSummary | NoSummary;

/**
 * A plan the adapter runs: the `prepare` actions (saving values) that run
 * first, each file's actions grouped with its status line, the `finish`
 * actions (the sync point) that run only when no step failed, the body lines
 * without the summary, and the exit code.
 */
export interface RunPlan {
  readonly prepare?: readonly Action[];
  readonly steps: readonly FileStep[];
  readonly finish: readonly Action[];
  readonly lines: readonly string[];
  readonly summary: Summary;
  readonly code: number;
  /** The placeholder whose missing value stopped the plan. */
  readonly missing?: string;
  /**
   * The new settings the plan couldn't route, in config entry order then the
   * split's order. Absent when the plan lists none.
   */
  readonly newSettings?: readonly NewSettingLine[];
}

/**
 * What running a plan's steps did: the contract's reason for each failed step
 * and the warnings to print before its line, both keyed by step index, plus
 * the dated-backup folder when a copy was made.
 */
export interface RunOutcome {
  readonly failed: ReadonlyMap<number, string>;
  readonly warnings: ReadonlyMap<number, readonly string[]>;
  readonly backups?: string;
}

/** The outcome of a plan whose steps all succeeded and wrote no warnings. */
export const NO_FAILURES: RunOutcome = {
  failed: new Map(),
  warnings: new Map(),
};
