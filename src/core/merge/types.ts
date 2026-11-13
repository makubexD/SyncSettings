import type { Result } from "../config/types.ts";

/** One layer's file for an entry: where it sits in the repo and its bytes. */
export interface LayerFile {
  readonly repoPath: string;
  readonly bytes: Uint8Array;
}

/** The line ending the local file gets on pull: LF everywhere, CRLF on Windows. */
export interface MergeContext {
  readonly eol: "\n" | "\r\n";
}

/** Where a split sends its changes, and the answers it may need. */
export interface SplitContext {
  /** Where a file goes when no layer holds it yet. */
  readonly writeRepoPath: string;
  /** Answers to "where does this new setting go?", keyed by key path. */
  readonly destinations?: Readonly<Record<string, string>>;
}

/** One layer's file after a split: its repo path and the bytes to write there. */
export interface LayerChange {
  readonly repoPath: string;
  readonly bytes: Uint8Array;
}

/**
 * One merge type's rule. `merge` builds the local file from the layers, which
 * are always in layer order (base, OS, profile, machine); `split` sends a
 * changed local file back to its layers. An error is a contract note, such as
 * "not valid JSON".
 */
export interface MergeStrategy {
  merge(
    layers: readonly LayerFile[],
    context: MergeContext,
  ): Result<Uint8Array, string>;
  split(
    local: Uint8Array,
    layers: readonly LayerFile[],
    context: SplitContext,
  ): Result<readonly LayerChange[], string>;
}
