/**
 * `mksync setting list` (contract "mksync setting", `mksync setting list`):
 * every setting a layer above the base sets, with a cell per layer that sets
 * it. Pure: the selected entries and the layer bytes in, the rows and the
 * listing's lines out.
 */

import type { Os } from "../config/types.ts";
import { parseJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { Layer, SelectedEntry } from "../layers/select.ts";
import {
  arrayKeyPath,
  childKeyPath,
  compactJson,
  countLines,
  exportFileLabel,
  fileLabel,
} from "./changes.ts";
import { layerWords } from "./newsettings.ts";
import type { RepoFiles } from "./types.ts";

/** A value longer than this is cut (decision 2). */
const VALUE_LIMIT = 40;

/** How much of a cut value is kept before the ellipsis. */
const KEPT_VALUE_LENGTH = 37;

const ELLIPSIS = "...";

const WHOLE_FILE = "(whole file)";

const NOTHING_LISTED = "(none)";

const PUBLIC_LAST_LINE = "Other profiles: unknown while the repo is public.";

const INDENT = "  ";

const COLUMN_GAP = "  ";

/** One layer's part of a row: its group words and what it holds there. */
export interface SettingCell {
  readonly group: string;
  readonly text: string;
}

/**
 * One listed setting: a json key path, or a whole file when `key` is absent.
 * `file` is the name the listing prints under the module: the entry's file
 * without its first folder, a `dir` entry's `<file>/<name inside>`, or an
 * `import` side file's resolved name.
 */
export interface SettingRow {
  readonly module: string;
  readonly file: string;
  readonly key?: string;
  readonly cells: readonly SettingCell[];
}

/** Whose settings the listing shows, for its header. */
export type SettingListTarget =
  | {
      readonly kind: "record";
      readonly machine: string;
      readonly profile: string;
    }
  | { readonly kind: "profile"; readonly profile: string }
  | { readonly kind: "none" };

/** While the repo is public, no other machine's profile is known here. */
export type RepoVisibility = "public" | "private";

/** A json key path a layer above the base sets, with how to find it. */
interface ListedPath {
  /** The object keys that lead to the value. */
  readonly keyPath: readonly string[];
  /** The path names an array, whose items are counted. */
  readonly array: boolean;
}

/** One layer's file, parsed when the entry is json. */
interface LayerFile {
  readonly layer: Layer;
  readonly bytes: Uint8Array;
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** A value's compact text, cut past the listing's 40 characters. */
function cutValue(text: string): string {
  return text.length > VALUE_LIMIT
    ? `${text.slice(0, KEPT_VALUE_LENGTH)}${ELLIPSIS}`
    : text;
}

function groupOf(layer: Layer, os: Os): string {
  return layerWords(layer.name, os, layer.label);
}

/**
 * Every key path `value` sets, as the block prints it: an object's keys one by
 * one, an array as one `[]` path, any other value (an empty object included)
 * as its own path.
 */
function collectPaths(
  value: JsonValue,
  path: string,
  keyPath: readonly string[],
  paths: Map<string, ListedPath>,
): void {
  if (value.kind === "object" && value.entries.size > 0) {
    for (const [key, child] of value.entries) {
      collectPaths(child, childKeyPath(path, key), [...keyPath, key], paths);
    }
    return;
  }
  const printed = value.kind === "array" ? arrayKeyPath(path) : path;
  // shortcut: a key holding a `.` and a nested path can print the same; the
  // first one found is listed, as the block can't tell them apart either.
  if (!paths.has(printed)) {
    paths.set(printed, { keyPath, array: value.kind === "array" });
  }
}

function valueAt(
  value: JsonValue,
  keyPath: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of keyPath) {
    if (current?.kind !== "object") {
      return undefined;
    }
    current = current.entries.get(key);
  }
  return current;
}

/** What one layer holds at `listed`, or nothing when it doesn't set it. */
function jsonCellText(
  value: JsonValue,
  listed: ListedPath,
): string | undefined {
  const found = valueAt(value, listed.keyPath);
  if (found === undefined) {
    return undefined;
  }
  if (listed.array) {
    return found.kind === "array" ? `${found.items.length} item(s)` : undefined;
  }
  if (found.kind === "object" && found.entries.size > 0) {
    return undefined;
  }
  return cutValue(compactJson(found));
}

function parseLayer(bytes: Uint8Array): JsonValue | undefined {
  const parsed = parseJson(textOf(bytes));
  return parsed.ok ? parsed.value : undefined;
}

/** A json entry's rows: one per key path a layer above the base sets. */
function jsonRows(
  entry: SelectedEntry,
  files: readonly LayerFile[],
  os: Os,
): readonly SettingRow[] {
  // shortcut: a layer that isn't valid JSON adds no path and no cell; the
  // import check and the export name it.
  const parsed = files.flatMap((file) => {
    const value = parseLayer(file.bytes);
    return value === undefined ? [] : [{ layer: file.layer, value }];
  });
  const paths = new Map<string, ListedPath>();
  for (const { layer, value } of parsed) {
    if (layer.name !== "base") {
      collectPaths(value, "", [], paths);
    }
  }
  const module = entry.entry.module;
  const file = fileLabel(entry.entry.file);
  return [...paths.keys()].sort(compareText).flatMap((key) => {
    const listed = paths.get(key);
    if (listed === undefined) {
      return [];
    }
    const cells = parsed.flatMap(({ layer, value }) => {
      const text = jsonCellText(value, listed);
      return text === undefined ? [] : [{ group: groupOf(layer, os), text }];
    });
    return [{ module, file, key, cells }];
  });
}

/** A whole file's cells: its line count, or the wider layer its bytes equal. */
function wholeCells(
  files: readonly LayerFile[],
  os: Os,
): readonly SettingCell[] {
  return files.map((file, index) => {
    const wider = files
      .slice(0, index)
      .find((other) => sameBytes(other.bytes, file.bytes));
    return {
      group: groupOf(file.layer, os),
      text:
        wider === undefined
          ? `${countLines(file.bytes)} line(s)`
          : `same as ${groupOf(wider.layer, os)}`,
    };
  });
}

/**
 * Every other kind's rows: one `(whole file)` row per printed name, so a `dir`
 * entry lists each file inside and an `import` entry each side file under its
 * resolved name. A name only the base holds isn't listed.
 */
function wholeRows(
  entry: SelectedEntry,
  files: RepoFiles,
  os: Os,
): readonly SettingRow[] {
  const byName = new Map<string, LayerFile[]>();
  for (const layer of entry.layers) {
    for (const [path, bytes] of layerPaths(entry, layer, files)) {
      const name = exportFileLabel(entry, layer, path);
      if (name === undefined) {
        continue;
      }
      const held = byName.get(name) ?? [];
      held.push({ layer, bytes });
      byName.set(name, held);
    }
  }
  const module = entry.entry.module;
  return [...byName.keys()].sort(compareText).flatMap((file) => {
    const held = byName.get(file) ?? [];
    if (held.every((item) => item.layer.name === "base")) {
      return [];
    }
    return [{ module, file, cells: wholeCells(held, os) }];
  });
}

/** The files a layer holds for the entry: its one file, or for a `dir` entry
 * every file under its folder, in path order. */
function layerPaths(
  entry: SelectedEntry,
  layer: Layer,
  files: RepoFiles,
): readonly (readonly [string, Uint8Array])[] {
  if (entry.entry.merge !== "dir") {
    const bytes = files.get(layer.repoPath);
    return bytes === undefined ? [] : [[layer.repoPath, bytes]];
  }
  const prefix = `${layer.repoPath}/`;
  return [...files.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .sort(([left], [right]) => compareText(left, right));
}

/**
 * The listing's rows, in the config's entry order, then by key path or name in
 * code-unit order. `files` holds every layer's bytes, keyed by the repo path
 * the snapshot uses; they are the layers' own text, so a value prints as its
 * placeholder.
 */
export function settingRows(
  selected: readonly SelectedEntry[],
  files: RepoFiles,
  os: Os,
): readonly SettingRow[] {
  return selected.flatMap((entry) => {
    if (!entry.layers.some((layer) => layer.name !== "base")) {
      return [];
    }
    if (entry.entry.merge !== "json") {
      return wholeRows(entry, files, os);
    }
    const held = entry.layers.flatMap((layer) => {
      const bytes = files.get(layer.repoPath);
      return bytes === undefined ? [] : [{ layer, bytes }];
    });
    return jsonRows(entry, held, os);
  });
}

/** The listing's first line (contract "mksync setting list"). */
export function settingListHeader(target: SettingListTarget): string {
  switch (target.kind) {
    case "record":
      return `Settings above the base on ${target.machine} (profile ${target.profile}):`;
    case "profile":
      return `Settings above the base in profile ${target.profile}:`;
    case "none":
      return "Settings above the base on this machine:";
    default: {
      const unhandled: never = target;
      throw new Error(`Unhandled target: ${String(unhandled)}`);
    }
  }
}

function widest(texts: readonly string[]): number {
  return texts.reduce((width, text) => Math.max(width, text.length), 0);
}

/**
 * The listing's lines: the header, a blank line, each module and file with its
 * settings under it, and while the repo is public a blank line and the line
 * that other profiles are unknown. Module and key are padded to the widest.
 */
export function renderSettingList(
  header: string,
  rows: readonly SettingRow[],
  visibility: RepoVisibility,
): readonly string[] {
  const lines = [header, ""];
  if (rows.length === 0) {
    lines.push(NOTHING_LISTED);
  }
  const moduleWidth = widest(rows.map((row) => row.module));
  const keyWidth = widest(rows.map((row) => row.key ?? WHOLE_FILE));
  let previous: SettingRow | undefined;
  for (const row of rows) {
    if (previous?.module !== row.module || previous.file !== row.file) {
      lines.push(`${row.module.padEnd(moduleWidth)}${COLUMN_GAP}${row.file}`);
    }
    const cells = row.cells
      .map((cell) => `${cell.group}: ${cell.text}`)
      .join(COLUMN_GAP);
    const key = (row.key ?? WHOLE_FILE).padEnd(keyWidth);
    lines.push(`${INDENT}${key}${COLUMN_GAP}${cells}`);
    previous = row;
  }
  if (visibility === "public") {
    lines.push("", PUBLIC_LAST_LINE);
  }
  return lines;
}
