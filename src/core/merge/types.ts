import type { Result } from "../config/types.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerName } from "../layers/select.ts";

/** One layer's file for an entry: where it sits in the repo and its bytes. */
export interface LayerFile {
  readonly repoPath: string;
  /** The file as the repo holds it: a merge works from these, and a `whole`
   * split compares them with the local file. */
  readonly bytes: Uint8Array;
  /** The same bytes with the run's values put back, when the entry has rules:
   * the `json` and `import` splits work from these. */
  readonly hydrated?: Uint8Array;
  /** The layer's status label, which an import side file's name substitutes. */
  readonly label?: string;
}

/** One layer slot in layer order, whether or not it holds a file yet. */
export interface LayerSlot {
  readonly name: LayerName;
  readonly repoPath: string;
}

/** The line ending the local file gets on pull: LF everywhere, CRLF on Windows. */
export interface MergeContext {
  readonly eol: "\n" | "\r\n";
  /** The local file's bytes, when this run has one: a json merge fills its
   * `localOnlyKeys` from them. */
  readonly local?: Uint8Array;
  /** Exact top-level key names the local file alone decides (json). */
  readonly localOnlyKeys?: readonly string[];
  /** The import side files' name pattern, with `{layer}` taking a layer's label. */
  readonly importName?: string;
}

/** Where a split sends its changes, and the answers it may need. */
export interface SplitContext {
  /** Where a file goes when no layer holds it yet. */
  readonly writeRepoPath: string;
  /** Answers to "where does this new setting go?", keyed by key path. */
  readonly destinations?: ReadonlyMap<string, LayerName>;
  /** Exact top-level key names the local file alone decides (json). */
  readonly localOnlyKeys?: readonly string[];
  /** The import side files' name pattern, with `{layer}` taking a layer's label. */
  readonly importName?: string;
  /** Every layer slot this run has, in layer order, whether or not it holds a
   * file: a json split may create a slot's file. */
  readonly slots?: readonly LayerSlot[];
  /** The plan's sanitizer for one file's bytes, which a whole split compares
   * the local file with its layer through. */
  readonly sanitize?: (bytes: Uint8Array) => Uint8Array;
  /** How a layer and the local file compare; byte equality when absent. */
  readonly compare?: (layer: Uint8Array, local: Uint8Array) => boolean;
}

/** One layer's file after a split: its repo path and the bytes to write there. */
export interface LayerChange {
  readonly repoPath: string;
  readonly bytes: Uint8Array;
}

/**
 * A key or array item the local file holds and no layer holds yet. `path` joins
 * object keys with "." and an array item as "[]", per the contract's wording.
 */
export interface NewSetting {
  readonly path: string;
  readonly value: JsonValue;
}

/** A file beside an `import` entry's local file: the layer it comes from and
 * the name it takes there. The plan reads its bytes from the local folder. */
export interface SideFile {
  readonly repoPath: string;
  readonly name: string;
}

/** What a split hands back: its changes, the new settings no layer could take,
 * the side files to write beside the local file, and the line an unchanged
 * file gets. */
export interface SplitResult {
  /** One change per layer whose content differs, in layer order. */
  readonly changes: readonly LayerChange[];
  /** New settings no layer could take; the file changes nothing then. */
  readonly newSettings: readonly NewSetting[];
  /** Files beside the local file, one per later import layer. */
  readonly sideFiles: readonly SideFile[];
  /** The repo path the file's status line names. */
  readonly label: string;
  /** The note every status line of the file takes, as an edited import block
   * does. */
  readonly note?: string;
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
  ): Result<SplitResult, string>;
}
