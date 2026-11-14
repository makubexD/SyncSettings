import type { Result } from "../config/types.ts";
import { jsonEqual, parseJson, writeJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerName } from "../layers/select.ts";
import type { LayerChange, LayerFile, NewSetting } from "./types.ts";

export type { LayerName };
export type { NewSetting };

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

/** The JSON value a file holds, or undefined when it isn't valid UTF-8 JSON. */
export function parseJsonBytes(bytes: Uint8Array): JsonValue | undefined {
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return undefined;
  }
  const parsed = parseJson(text);
  return parsed.ok ? parsed.value : undefined;
}

function parseLayer(layer: LayerFile): Result<JsonValue, string> {
  const parsed = parseJsonBytes(layer.bytes);
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
    local.bytes === undefined ? undefined : parseJsonBytes(local.bytes);
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

/**
 * One layer slot in layer order (base, OS, profile, machine). `bytes` is
 * undefined when this machine has the layer but it holds no file yet: a merge
 * skips it, and a change may create it.
 */
export interface JsonLayer {
  readonly name: LayerName;
  readonly repoPath: string;
  readonly bytes: Uint8Array | undefined;
}

/** One change per layer whose content differs, in layer order, plus the new
 * settings no layer could take. */
export interface JsonSplit {
  readonly changes: readonly LayerChange[];
  readonly newSettings: readonly NewSetting[];
}

const INVALID_JSON = "not valid JSON";
const EMPTY_OBJECT: JsonValue = { kind: "object", entries: new Map() };
const EMPTY_DESTINATIONS: ReadonlyMap<string, LayerName> = new Map();

interface SplitState {
  readonly name: LayerName;
  readonly repoPath: string;
  /** Whether this slot's file exists. Only present states can be an entry's
   * one layer, so a missing OS slot beside a present base doesn't count. */
  readonly present: boolean;
  value: JsonValue | undefined;
  changed: boolean;
}

interface SplitContext {
  readonly states: readonly SplitState[];
  readonly destinations: ReadonlyMap<string, LayerName>;
  readonly newSettings: NewSetting[];
}

function joinPath(segments: readonly string[]): string {
  return segments.join(".");
}

/** Whether `value` holds every key of `segments`, each inside an object. */
function hasKeyPath(value: JsonValue, segments: readonly string[]): boolean {
  if (segments.length === 0) {
    return true;
  }
  const head = segments[0];
  if (head === undefined || value.kind !== "object") {
    return false;
  }
  const child = value.entries.get(head);
  return child !== undefined && hasKeyPath(child, segments.slice(1));
}

/** The value at an object-key path, or undefined when the path leaves objects. */
function getAtPath(
  value: JsonValue | undefined,
  segments: readonly string[],
): JsonValue | undefined {
  let current = value;
  for (const segment of segments) {
    if (current === undefined || current.kind !== "object") {
      return undefined;
    }
    current = current.entries.get(segment);
  }
  return current;
}

/** A copy of `value` with the key at `segments` set to `replacement`, creating
 * missing parent objects. An existing key keeps its position. */
function setKeyPath(
  value: JsonValue,
  segments: readonly string[],
  replacement: JsonValue,
): JsonValue {
  if (segments.length === 0) {
    return replacement;
  }
  const head = segments[0];
  if (head === undefined) {
    return value;
  }
  const tail = segments.slice(1);
  const entries = value.kind === "object" ? new Map(value.entries) : new Map();
  if (tail.length === 0) {
    entries.set(head, replacement);
  } else {
    const child = entries.get(head);
    entries.set(head, setKeyPath(child ?? EMPTY_OBJECT, tail, replacement));
  }
  return { kind: "object", entries };
}

/** A copy of `value` with the key at `segments` removed. */
function removeKeyPath(
  value: JsonValue,
  segments: readonly string[],
): JsonValue {
  if (segments.length === 0 || value.kind !== "object") {
    return value;
  }
  const head = segments[0];
  if (head === undefined) {
    return value;
  }
  const tail = segments.slice(1);
  const entries = new Map(value.entries);
  if (tail.length === 0) {
    entries.delete(head);
    return { kind: "object", entries };
  }
  const child = entries.get(head);
  if (child === undefined) {
    return value;
  }
  entries.set(head, removeKeyPath(child, tail));
  return { kind: "object", entries };
}

/** A copy of `value` with `item` appended to the array at `segments`, creating
 * the array and its parent objects when missing. */
function appendArrayItem(
  value: JsonValue,
  segments: readonly string[],
  item: JsonValue,
): JsonValue {
  if (segments.length === 0) {
    const items = value.kind === "array" ? [...value.items] : [];
    items.push(item);
    return { kind: "array", items };
  }
  const head = segments[0];
  if (head === undefined) {
    return value;
  }
  const tail = segments.slice(1);
  const entries = value.kind === "object" ? new Map(value.entries) : new Map();
  const child = entries.get(head);
  entries.set(head, appendArrayItem(child ?? EMPTY_OBJECT, tail, item));
  return { kind: "object", entries };
}

/** A copy of `value` with only the `keys` (top-level) kept out. */
function withoutTopLevelKeys(
  value: JsonValue,
  keys: readonly string[],
): JsonValue {
  if (value.kind !== "object" || keys.length === 0) {
    return value;
  }
  const entries = new Map(value.entries);
  for (const key of keys) {
    entries.delete(key);
  }
  return { kind: "object", entries };
}

/** The layer slot a new setting goes to, or undefined when none can take it:
 * the destination's slot when this run has it, else the one present layer. */
function resolveNewSettingTarget(
  lookupKey: string,
  context: SplitContext,
): SplitState | undefined {
  const destination = context.destinations.get(lookupKey);
  if (destination !== undefined) {
    const named = context.states.find((state) => state.name === destination);
    if (named !== undefined) {
      return named;
    }
  }
  const present = context.states.filter((state) => state.present);
  if (present.length === 1) {
    return present[0];
  }
  return undefined;
}

function addNewKey(
  segments: readonly string[],
  value: JsonValue,
  context: SplitContext,
): void {
  const path = joinPath(segments);
  const target = resolveNewSettingTarget(path, context);
  if (target === undefined) {
    context.newSettings.push({ path, value });
    return;
  }
  target.value = setKeyPath(target.value ?? EMPTY_OBJECT, segments, value);
  target.changed = true;
}

function addNewArrayItem(
  segments: readonly string[],
  item: JsonValue,
  context: SplitContext,
): void {
  const arrayPath = joinPath(segments);
  const itemPath = `${arrayPath}[]`;
  const target = resolveNewSettingTarget(itemPath, context);
  if (target === undefined) {
    context.newSettings.push({ path: itemPath, value: item });
    return;
  }
  target.value = appendArrayItem(target.value ?? EMPTY_OBJECT, segments, item);
  target.changed = true;
}

/** A key removed from the local file goes out of every layer that sets it, so
 * an earlier layer's value can't resurface. */
function removeKeyFromEveryLayer(
  segments: readonly string[],
  context: SplitContext,
): void {
  for (const state of context.states) {
    const value = state.value;
    if (value !== undefined && hasKeyPath(value, segments)) {
      state.value = removeKeyPath(value, segments);
      state.changed = true;
    }
  }
}

/** An array item removed from the local file goes out of every layer whose
 * array holds it: the layer that added it and any later repeat. */
function removeItemFromEveryLayer(
  segments: readonly string[],
  item: JsonValue,
  context: SplitContext,
): void {
  for (const state of context.states) {
    const value = state.value;
    if (value === undefined) {
      continue;
    }
    const array = getAtPath(value, segments);
    if (array === undefined || array.kind !== "array") {
      continue;
    }
    const kept = array.items.filter((existing) => !jsonEqual(existing, item));
    if (kept.length === array.items.length) {
      continue;
    }
    state.value = setKeyPath(value, segments, { kind: "array", items: kept });
    state.changed = true;
  }
}

/** A changed scalar or a type change goes to the latest layer that sets the
 * key path, keeping that key's position in the layer. */
function setInLatestLayer(
  segments: readonly string[],
  value: JsonValue,
  context: SplitContext,
): void {
  for (let index = context.states.length - 1; index >= 0; index--) {
    const state = context.states[index];
    if (state === undefined) {
      continue;
    }
    if (state.value !== undefined && hasKeyPath(state.value, segments)) {
      state.value = setKeyPath(state.value, segments, value);
      state.changed = true;
      return;
    }
  }
  // A changed key always has a layer that sets it; with no present layer the
  // merged value is the empty object, so the key is new, not changed.
}

function diffArrays(
  local: readonly JsonValue[],
  merged: readonly JsonValue[],
  path: readonly string[],
  context: SplitContext,
): void {
  for (const item of merged) {
    if (!local.some((existing) => jsonEqual(existing, item))) {
      removeItemFromEveryLayer(path, item, context);
    }
  }
  for (const item of local) {
    if (!merged.some((existing) => jsonEqual(existing, item))) {
      addNewArrayItem(path, item, context);
    }
  }
}

function diffObjects(
  local: ReadonlyMap<string, JsonValue>,
  merged: ReadonlyMap<string, JsonValue>,
  path: readonly string[],
  context: SplitContext,
): void {
  for (const [key] of merged) {
    if (!local.has(key)) {
      removeKeyFromEveryLayer([...path, key], context);
    }
  }
  for (const [key, localValue] of local) {
    const mergedValue = merged.get(key);
    if (mergedValue === undefined) {
      addNewKey([...path, key], localValue, context);
    } else {
      diffValues(localValue, mergedValue, [...path, key], context);
    }
  }
}

function diffValues(
  local: JsonValue,
  merged: JsonValue,
  path: readonly string[],
  context: SplitContext,
): void {
  if (local.kind === "object" && merged.kind === "object") {
    diffObjects(local.entries, merged.entries, path, context);
    return;
  }
  if (local.kind === "array" && merged.kind === "array") {
    diffArrays(local.items, merged.items, path, context);
    return;
  }
  if (jsonEqual(local, merged)) {
    return;
  }
  setInLatestLayer(path, local, context);
}

/**
 * Splits a changed local file back into its layers, per the contract's
 * "Splitting a changed file": the parsed local file is compared with the merge
 * of the present layers (the empty object with none), and each difference goes
 * to one layer. A new key or array item with no layer to take it lands in
 * `newSettings`, and then nothing of the file changes at all. `localOnlyKeys`
 * are ignored on both sides, and values are written as they are: the caller
 * sanitizes.
 *
 * Errors: a present layer that isn't JSON is `not valid JSON: <layer path>`,
 * and a local file that isn't valid UTF-8 or JSON is `not valid JSON`.
 */
export function splitJson(
  local: Uint8Array,
  layers: readonly JsonLayer[],
  options: {
    readonly destinations?: ReadonlyMap<string, LayerName>;
    readonly localOnlyKeys?: readonly string[];
  },
): Result<JsonSplit, string> {
  const localValue = parseJsonBytes(local);
  if (localValue === undefined) {
    return { ok: false, error: INVALID_JSON };
  }

  const states: SplitState[] = [];
  const values: JsonValue[] = [];
  for (const layer of layers) {
    const parsed =
      layer.bytes === undefined ? undefined : parseJsonBytes(layer.bytes);
    if (layer.bytes !== undefined && parsed === undefined) {
      return { ok: false, error: `not valid JSON: ${layer.repoPath}` };
    }
    states.push({
      name: layer.name,
      repoPath: layer.repoPath,
      present: layer.bytes !== undefined,
      value: parsed,
      changed: false,
    });
    if (parsed !== undefined) {
      values.push(parsed);
    }
  }

  const merged = values.length === 0 ? EMPTY_OBJECT : mergeJsonValues(values);
  const localOnlyKeys = options.localOnlyKeys ?? [];

  const context: SplitContext = {
    states,
    destinations: options.destinations ?? EMPTY_DESTINATIONS,
    newSettings: [],
  };
  diffValues(
    withoutTopLevelKeys(localValue, localOnlyKeys),
    withoutTopLevelKeys(merged, localOnlyKeys),
    [],
    context,
  );

  if (context.newSettings.length > 0) {
    return {
      ok: true,
      value: { changes: [], newSettings: context.newSettings },
    };
  }

  const changes: LayerChange[] = [];
  for (const state of states) {
    if (state.changed && state.value !== undefined) {
      changes.push({
        repoPath: state.repoPath,
        bytes: new TextEncoder().encode(writeJson(state.value, "\n")),
      });
    }
  }
  return { ok: true, value: { changes, newSettings: context.newSettings } };
}
