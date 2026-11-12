import type { Result } from "../config/types.ts";
import { jsonEqual, parseJson, writeJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerFile } from "./types.ts";

const NO_LAYERS = "mergeJsonValues needs at least one layer";

function mergeObjectValues(
  earlier: ReadonlyMap<string, JsonValue>,
  later: ReadonlyMap<string, JsonValue>,
): JsonValue {
  const entries = new Map<string, JsonValue>(earlier);
  for (const [key, value] of later) {
    const earlierValue = entries.get(key);
    entries.set(
      key,
      earlierValue === undefined ? value : mergeValues(earlierValue, value),
    );
  }
  return { kind: "object", entries };
}

function mergeArrayValues(
  earlier: readonly JsonValue[],
  later: readonly JsonValue[],
): JsonValue {
  const items = [...earlier];
  for (const item of later) {
    if (!items.some((existing) => jsonEqual(existing, item))) {
      items.push(item);
    }
  }
  return { kind: "array", items };
}

function mergeValues(earlier: JsonValue, later: JsonValue): JsonValue {
  if (earlier.kind === "object" && later.kind === "object") {
    return mergeObjectValues(earlier.entries, later.entries);
  }
  if (earlier.kind === "array" && later.kind === "array") {
    return mergeArrayValues(earlier.items, later.items);
  }
  return later;
}

/**
 * Merges parsed layer values in layer order (base, OS, profile, machine), per
 * the design's rules 1 to 3: objects merge key by key, a later value wins
 * unless both values are objects; arrays collect the base's items in order,
 * then each later layer's items that aren't equal to one already there. Key
 * order is the earliest layer's, then keys only later layers have in their
 * order; a key a later layer replaces keeps its position.
 *
 * @throws RangeError when `layers` is empty; a caller always has a layer.
 */
export function mergeJsonValues(layers: readonly JsonValue[]): JsonValue {
  const first = layers[0];
  if (first === undefined) {
    throw new RangeError(NO_LAYERS);
  }
  let merged = first;
  for (let index = 1; index < layers.length; index++) {
    const layer = layers[index];
    if (layer !== undefined) {
      merged = mergeValues(merged, layer);
    }
  }
  return merged;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Invalid UTF-8 counts as not JSON, for a layer and for the local file.
    return undefined;
  }
}

function parseBytes(bytes: Uint8Array): JsonValue | undefined {
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return undefined;
  }
  const parsed = parseJson(text);
  return parsed.ok ? parsed.value : undefined;
}

function parseLayer(layer: LayerFile): Result<JsonValue, string> {
  const parsed = parseBytes(layer.bytes);
  return parsed === undefined
    ? { ok: false, error: `not valid JSON: ${layer.repoPath}` }
    : { ok: true, value: parsed };
}

/**
 * Fills `localOnlyKeys` from the local file, which alone decides them. A key
 * the local file's object holds takes its local value, at the merged position
 * when the merge has the key and appended at the end otherwise; a key the
 * local file doesn't hold is removed. A missing local file, one that isn't
 * valid JSON and one that isn't an object all count as holding no keys. When
 * the merged value isn't an object, the keys don't apply.
 */
function applyLocalOnlyKeys(
  merged: JsonValue,
  local: {
    readonly bytes: Uint8Array | undefined;
    readonly localOnlyKeys: readonly string[];
  },
): JsonValue {
  if (merged.kind !== "object") {
    return merged;
  }
  const localValue =
    local.bytes === undefined ? undefined : parseBytes(local.bytes);
  const localEntries =
    localValue !== undefined && localValue.kind === "object"
      ? localValue.entries
      : undefined;
  const entries = new Map<string, JsonValue>(merged.entries);
  for (const key of local.localOnlyKeys) {
    const value = localEntries?.get(key);
    if (value === undefined) {
      entries.delete(key);
    } else {
      entries.set(key, value);
    }
  }
  return { kind: "object", entries };
}

/**
 * Builds the local file from an entry's layers: each one decoded as UTF-8 and
 * parsed strictly, the values hydrated already, merged with
 * `mergeJsonValues`, then `localOnlyKeys` filled from the local file and the
 * result written in the contract's layout with `eol`.
 *
 * A layer that isn't valid JSON is the error `not valid JSON: <layer path>`,
 * naming the first failing layer. `localOnlyKeys` are exact top-level key
 * names, never key paths, as VS Code keys such as `window.zoomLevel` contain
 * dots.
 */
export function mergeJson(
  layers: readonly LayerFile[],
  eol: "\n" | "\r\n",
  local?: {
    readonly bytes: Uint8Array | undefined;
    readonly localOnlyKeys: readonly string[];
  },
): Result<Uint8Array, string> {
  const values: JsonValue[] = [];
  for (const layer of layers) {
    const parsed = parseLayer(layer);
    if (!parsed.ok) {
      return parsed;
    }
    values.push(parsed.value);
  }
  const merged = mergeJsonValues(values);
  const result =
    local === undefined ? merged : applyLocalOnlyKeys(merged, local);
  return { ok: true, value: new TextEncoder().encode(writeJson(result, eol)) };
}
