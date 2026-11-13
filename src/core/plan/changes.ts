import { jsonEqual, parseJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import { selectEntries } from "../layers/select.ts";
import type { Layer, LayerName, SelectedEntry } from "../layers/select.ts";
import { joinPath, resolvedLocal, scopeFor, separatorFor } from "./pick.ts";
import type {
  Action,
  ChangeLine,
  RepoFiles,
  RunPlan,
  Snapshot,
} from "./types.ts";

const VALUE_LIMIT = 60;
const KEPT_VALUE_LENGTH = 57;
const ELLIPSIS = "...";
const FIRST_PRINTABLE = 0x20;

/** The line kinds' order when two lines share a key path: `-` before `+`. */
const KIND_ORDER: Readonly<Record<ChangeLine["kind"], number>> = {
  "-": 0,
  M: 1,
  "+": 2,
};

/** One json change before it carries its layer: the file's sorted parts need
 * the key path, and an import assigns each part its own layer. */
interface DraftLine {
  /** The key path as the contract prints it, an array item ending in `[]`. */
  readonly path: string;
  /** The object keys that lead to the changed value, for a layer lookup. */
  readonly keyPath: readonly string[];
  readonly kind: ChangeLine["kind"];
  readonly what: string;
  /** The items of the array a new key path gains; only an added key carries
   * them, so a layer that gains an array another layer holds prints items. */
  readonly addedItems?: readonly JsonValue[];
}

interface MatchedLayer {
  readonly entry: SelectedEntry;
  readonly layer: Layer;
}

interface ImportMatch extends MatchedLayer {
  readonly file: string;
  readonly json: boolean;
}

interface LayerValue {
  readonly layer: Layer;
  readonly value: JsonValue;
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function quote(text: string): string {
  let quoted = '"';
  for (const char of text) {
    switch (char) {
      case '"':
        quoted += '\\"';
        continue;
      case "\\":
        quoted += "\\\\";
        continue;
      case "\b":
        quoted += "\\b";
        continue;
      case "\f":
        quoted += "\\f";
        continue;
      case "\n":
        quoted += "\\n";
        continue;
      case "\r":
        quoted += "\\r";
        continue;
      case "\t":
        quoted += "\\t";
        continue;
      default: {
        const code = char.codePointAt(0) ?? 0;
        quoted +=
          code < FIRST_PRINTABLE
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : char;
      }
    }
  }
  return `${quoted}"`;
}

/** Compact JSON on one line, keeping a number's source text: `"text"`, `14`,
 * `{"a":1}`, `[1,2]`. `value.ts` writes only the contract's multi-line form. */
export function compactJson(value: JsonValue): string {
  switch (value.kind) {
    case "null":
      return "null";
    case "bool":
      return value.value ? "true" : "false";
    case "number":
      return value.text;
    case "string":
      return quote(value.value);
    case "array":
      return `[${value.items.map(compactJson).join(",")}]`;
    case "object": {
      const fields = [...value.entries].map(
        ([key, item]) => `${quote(key)}:${compactJson(item)}`,
      );
      return `{${fields.join(",")}}`;
    }
    default: {
      const unhandled: never = value;
      throw new Error(`Unhandled JSON value: ${String(unhandled)}`);
    }
  }
}

/** A change's value, compact and cut to the contract's 60 characters. */
export function valueText(value: JsonValue): string {
  const text = compactJson(value);
  return text.length > VALUE_LIMIT
    ? `${text.slice(0, KEPT_VALUE_LENGTH)}${ELLIPSIS}`
    : text;
}

function emptyObject(): JsonValue {
  return { kind: "object", entries: new Map() };
}

function parseBytes(bytes: Uint8Array): JsonValue | undefined {
  const parsed = parseJson(textOf(bytes));
  return parsed.ok ? parsed.value : undefined;
}

function compareDrafts(left: DraftLine, right: DraftLine): number {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
}

function diffValues(
  oldValue: JsonValue,
  newValue: JsonValue,
  path: string,
  keyPath: readonly string[],
  lines: DraftLine[],
): void {
  if (oldValue.kind === "object" && newValue.kind === "object") {
    const keys = new Set([
      ...oldValue.entries.keys(),
      ...newValue.entries.keys(),
    ]);
    for (const key of keys) {
      const before = oldValue.entries.get(key);
      const after = newValue.entries.get(key);
      const childPath = [...keyPath, key];
      const printed = path === "" ? key : `${path}.${key}`;
      if (before === undefined && after !== undefined) {
        lines.push({
          path: printed,
          keyPath: childPath,
          kind: "+",
          what: valueText(after),
          ...(after.kind === "array" ? { addedItems: after.items } : {}),
        });
      } else if (before !== undefined && after === undefined) {
        lines.push({
          path: printed,
          keyPath: childPath,
          kind: "-",
          what: valueText(before),
        });
      } else if (before !== undefined && after !== undefined) {
        diffValues(before, after, printed, childPath, lines);
      }
    }
    return;
  }
  if (oldValue.kind === "array" && newValue.kind === "array") {
    const printed = `${path}[]`;
    const matched = new Array<boolean>(newValue.items.length).fill(false);
    for (const item of oldValue.items) {
      const at = newValue.items.findIndex(
        (other, index) => matched[index] !== true && jsonEqual(item, other),
      );
      if (at === -1) {
        lines.push({
          path: printed,
          keyPath,
          kind: "-",
          what: valueText(item),
        });
      } else {
        matched[at] = true;
      }
    }
    for (let index = 0; index < newValue.items.length; index++) {
      const item = newValue.items[index];
      if (item !== undefined && matched[index] !== true) {
        lines.push({
          path: printed,
          keyPath,
          kind: "+",
          what: valueText(item),
        });
      }
    }
    return;
  }
  if (!jsonEqual(oldValue, newValue)) {
    lines.push({
      path,
      keyPath,
      kind: "M",
      what: `${valueText(oldValue)} -> ${valueText(newValue)}`,
    });
  }
}

/** One file's json changes, sorted by key path with `-` before `+`. */
function jsonDrafts(
  oldValue: JsonValue,
  newValue: JsonValue,
): readonly DraftLine[] {
  const drafts: DraftLine[] = [];
  diffValues(oldValue, newValue, "", [], drafts);
  return [...drafts].sort(compareDrafts);
}

/** Lines split at LF or CRLF, without the empty tail a trailing newline
 * leaves. */
function splitLines(text: string): readonly string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The longest common subsequence's length, two rows at a time. */
function commonLines(
  left: readonly string[],
  right: readonly string[],
): number {
  const columns = right.length;
  let previous = new Array<number>(columns + 1).fill(0);
  let current = new Array<number>(columns + 1).fill(0);
  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= columns; column++) {
      const diagonal = previous[column - 1] ?? 0;
      current[column] =
        left[row - 1] === right[column - 1]
          ? diagonal + 1
          : Math.max(previous[column] ?? 0, current[column - 1] ?? 0);
    }
    const swapped = previous;
    previous = current;
    current = swapped;
    current.fill(0);
  }
  return previous[columns] ?? 0;
}

function countLines(bytes: Uint8Array): number {
  return splitLines(textOf(bytes)).length;
}

function changedLines(oldBytes: Uint8Array, newBytes: Uint8Array): number {
  const oldLines = splitLines(textOf(oldBytes));
  const newLines = splitLines(textOf(newBytes));
  const common = commonLines(oldLines, newLines);
  return Math.max(newLines.length - common, oldLines.length - common);
}

/** The entry's `file` without its first folder: `claude/docs/x.html` is
 * `docs/x.html` (contract "Push preview (program only)", The file). */
export function fileLabel(file: string): string {
  const slash = file.indexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

function parentDir(path: string, separator: "/" | "\\"): string {
  const slash = path.lastIndexOf(separator);
  return slash <= 0 ? path : path.slice(0, slash);
}

/** The selected entry and layer an export action writes: an exact layer path,
 * or a `dir` entry's folder prefix. */
function matchExportEntry(
  selected: readonly SelectedEntry[],
  path: string,
): MatchedLayer | undefined {
  for (const entry of selected) {
    for (const layer of entry.slots) {
      if (layer.repoPath === path) {
        return { entry, layer };
      }
      if (
        entry.entry.merge === "dir" &&
        path.startsWith(`${layer.repoPath}/`)
      ) {
        return { entry, layer };
      }
    }
  }
  return undefined;
}

/** A whole file's line count change, whether the action writes or removes it. */
function wholeLines(
  layer: LayerName,
  module: string,
  file: string,
  oldBytes: Uint8Array | undefined,
  newBytes: Uint8Array | undefined,
): readonly ChangeLine[] {
  if (newBytes === undefined) {
    if (oldBytes === undefined) {
      return [];
    }
    // shortcut: the contract has no separate line for a removed dir file, so
    // it reads as changed with its old line count.
    return [
      {
        layer,
        kind: "-",
        module,
        file,
        what: `${countLines(oldBytes)} line(s) changed`,
      },
    ];
  }
  if (oldBytes === undefined) {
    return [
      {
        layer,
        kind: "+",
        module,
        file,
        what: `new file, ${countLines(newBytes)} line(s)`,
      },
    ];
  }
  return [
    {
      layer,
      kind: "M",
      module,
      file,
      what: `${changedLines(oldBytes, newBytes)} line(s) changed`,
    },
  ];
}

function exportFileLabel(
  entry: SelectedEntry,
  layer: Layer,
  path: string,
): string | undefined {
  const config = entry.entry;
  if (config.merge === "dir") {
    return `${config.file}/${path.slice(layer.repoPath.length + 1)}`;
  }
  if (config.merge !== "import") {
    return fileLabel(config.file);
  }
  const importName = config.importName;
  if (importName === undefined) {
    return undefined;
  }
  // The first present layer holds the base text; the rest are side files.
  const base = entry.layers[0];
  return base !== undefined && base.repoPath === layer.repoPath
    ? fileLabel(config.file)
    : importName.replaceAll("{layer}", layer.label);
}

/** One json draft's preview lines: a new key path whose value is an array, and
 * which another layer of the entry already holds, prints one line per item
 * (contract "Push preview", "What changed"); any other draft prints its own
 * line. */
function exportedDraftLines(
  draft: DraftLine,
  match: MatchedLayer,
  module: string,
  file: string,
  otherLayers: readonly LayerValue[],
): readonly ChangeLine[] {
  const items = draft.addedItems;
  if (
    items !== undefined &&
    otherLayers.some((item) => hasKeyPath(item.value, draft.keyPath))
  ) {
    return items.map((item) => ({
      layer: match.layer.name,
      kind: "+",
      module,
      file,
      what: `${draft.path}[]: ${valueText(item)}`,
    }));
  }
  return [
    {
      layer: match.layer.name,
      kind: draft.kind,
      module,
      file,
      what: `${draft.path}: ${draft.what}`,
    },
  ];
}

function exportActionLines(
  match: MatchedLayer,
  action: Action,
  repoFiles: RepoFiles,
): readonly ChangeLine[] {
  if (action.kind !== "writeRepo" && action.kind !== "removeRepo") {
    return [];
  }
  const config = match.entry.entry;
  const oldBytes = repoFiles.get(action.path);
  const newBytes = action.kind === "writeRepo" ? action.bytes : undefined;

  if (config.merge === "json") {
    if (newBytes === undefined) {
      return [];
    }
    const oldValue =
      oldBytes === undefined ? emptyObject() : parseBytes(oldBytes);
    const newValue = parseBytes(newBytes);
    // shortcut: a layer file export would refuse to split is not valid JSON;
    // the plan holds no action for it, so nothing is printed for it here.
    if (oldValue === undefined || newValue === undefined) {
      return [];
    }
    const otherLayers = layerValues(match.entry, repoFiles).filter(
      (item) => item.layer.repoPath !== match.layer.repoPath,
    );
    return jsonDrafts(oldValue, newValue).flatMap((draft) =>
      exportedDraftLines(
        draft,
        match,
        config.module,
        fileLabel(config.file),
        otherLayers,
      ),
    );
  }

  const file = exportFileLabel(match.entry, match.layer, action.path);
  if (file === undefined) {
    return [];
  }
  return wholeLines(
    match.layer.name,
    config.module,
    file,
    oldBytes,
    newBytes,
  );
}

/**
 * Contract "Push preview (program only)": one line per change an export plan
 * would write, in the plan's action order, each json file's lines sorted by
 * key path. Actions no selected entry's layer owns are left out.
 */
export function changeLines(
  plan: RunPlan,
  snapshot: Snapshot,
): readonly ChangeLine[] {
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return [];
  }
  const lines: ChangeLine[] = [];
  for (const step of plan.steps) {
    for (const item of step.actions) {
      const action = item.action;
      if (action.kind !== "writeRepo" && action.kind !== "removeRepo") {
        continue;
      }
      const match = matchExportEntry(selected.value, action.path);
      if (match === undefined) {
        continue;
      }
      lines.push(...exportActionLines(match, action, snapshot.repoFiles));
    }
  }
  return lines;
}

/** The selected entry and layer an import action writes: the entry's own local
 * file, its resolved side file, or a file inside its `dir` folder. */
function matchImportEntry(
  selected: readonly SelectedEntry[],
  path: string,
  snapshot: Snapshot,
): ImportMatch | undefined {
  const separator = separatorFor(snapshot.os);
  for (const entry of selected) {
    const config = entry.entry;
    const localPath = resolvedLocal(config, snapshot.os, snapshot.home);
    if (config.merge === "import") {
      const importName = config.importName;
      if (importName !== undefined) {
        const folder = parentDir(localPath, separator);
        // The first present layer is the base text; only later ones are sides.
        for (const layer of entry.layers.slice(1)) {
          const name = importName.replaceAll("{layer}", layer.label);
          if (joinPath(folder, name, separator) === path) {
            return { entry, layer, file: name, json: false };
          }
        }
      }
      const source = entry.source;
      if (path === localPath && source !== undefined) {
        return { entry, layer: source, file: fileLabel(config.file), json: false };
      }
      continue;
    }
    if (config.merge === "dir") {
      const prefix = `${localPath}${separator}`;
      const source = entry.source;
      if (path.startsWith(prefix) && source !== undefined) {
        const relative = path
          .slice(prefix.length)
          .replaceAll(separator, "/");
        return {
          entry,
          layer: source,
          file: `${config.file}/${relative}`,
          json: false,
        };
      }
      continue;
    }
    const source = entry.source;
    if (path === localPath && source !== undefined) {
      return {
        entry,
        layer: source,
        file: fileLabel(config.file),
        json: config.merge === "json",
      };
    }
  }
  return undefined;
}

function hasKeyPath(value: JsonValue, keyPath: readonly string[]): boolean {
  let current = value;
  for (const key of keyPath) {
    if (current.kind !== "object") {
      return false;
    }
    const next = current.entries.get(key);
    if (next === undefined) {
      return false;
    }
    current = next;
  }
  return true;
}

function latestLayer(entry: SelectedEntry): Layer | undefined {
  return entry.layers[entry.layers.length - 1];
}

/** Each present layer's repo value, in layer order. Values are not hydrated:
 * only key presence matters for a line's layer. */
function layerValues(
  entry: SelectedEntry,
  repoFiles: RepoFiles,
): readonly LayerValue[] {
  const values: LayerValue[] = [];
  for (const layer of entry.layers) {
    const bytes = repoFiles.get(layer.repoPath);
    if (bytes === undefined) {
      continue;
    }
    const value = parseBytes(bytes);
    if (value === undefined) {
      continue;
    }
    values.push({ layer, value });
  }
  return values;
}

/** The latest layer that sets a changed or added key; a key the import drops
 * has no layer of its own here, so it takes the entry's latest one. */
function draftLayer(
  draft: DraftLine,
  entry: SelectedEntry,
  values: readonly LayerValue[],
): Layer | undefined {
  if (draft.kind !== "-") {
    for (let index = values.length - 1; index >= 0; index--) {
      const item = values[index];
      if (item !== undefined && hasKeyPath(item.value, draft.keyPath)) {
        return item.layer;
      }
    }
  }
  return latestLayer(entry);
}

function importActionLines(
  match: ImportMatch,
  action: Action,
  snapshot: Snapshot,
): readonly ChangeLine[] {
  if (action.kind !== "writeLocal") {
    return [];
  }
  const local = snapshot.localFiles.get(action.path);
  const oldBytes = local !== undefined && local.kind === "file" ? local.bytes : undefined;
  const config = match.entry.entry;

  if (match.json) {
    const oldValue =
      oldBytes === undefined ? emptyObject() : parseBytes(oldBytes);
    const newValue = parseBytes(action.bytes);
    if (oldValue === undefined || newValue === undefined) {
      return [];
    }
    const values = layerValues(match.entry, snapshot.repoFiles);
    const lines: ChangeLine[] = [];
    for (const draft of jsonDrafts(oldValue, newValue)) {
      const layer = draftLayer(draft, match.entry, values);
      if (layer === undefined) {
        continue;
      }
      lines.push({
        layer: layer.name,
        kind: draft.kind,
        module: config.module,
        file: match.file,
        what: `${draft.path}: ${draft.what}`,
      });
    }
    return lines;
  }

  return wholeLines(
    match.layer.name,
    config.module,
    match.file,
    oldBytes,
    action.bytes,
  );
}

/**
 * Contract "Import check", the grouped block: one line per change an import
 * plan would write, in the plan's action order, each json file's lines sorted
 * by key path and given the layer their new value comes from.
 */
export function importChangeLines(
  plan: RunPlan,
  snapshot: Snapshot,
): readonly ChangeLine[] {
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return [];
  }
  const lines: ChangeLine[] = [];
  for (const step of plan.steps) {
    for (const item of step.actions) {
      if (item.action.kind !== "writeLocal") {
        continue;
      }
      const match = matchImportEntry(
        selected.value,
        item.action.path,
        snapshot,
      );
      if (match === undefined) {
        continue;
      }
      lines.push(...importActionLines(match, item.action, snapshot));
    }
  }
  return lines;
}
