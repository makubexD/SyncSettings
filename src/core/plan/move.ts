import type { Result } from "../config/types.ts";
import { jsonEqual, writeJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerName } from "../layers/select.ts";
import { mergeJsonValues, parseJsonBytes } from "../merge/json.ts";
import type { JsonLayer } from "../merge/json.ts";

const ENCODER = new TextEncoder();
const ITEM_SUFFIX = "[]";
const KEY_SEPARATOR = ".";

/** The key segments a new-setting path names. A path is its literal key when
 * the source object holds it as one key, as VS Code keys such as
 * "editor.fontSize" do, and object keys joined with "." otherwise. */
function segmentsFor(
  root: JsonValue,
  path: string,
  kind: "key" | "item",
): readonly string[] {
  const keyPath = kind === "item" ? path.slice(0, -ITEM_SUFFIX.length) : path;
  if (keyPath === "") {
    return [];
  }
  if (root.kind === "object" && root.entries.has(keyPath)) {
    return [keyPath];
  }
  return keyPath.split(KEY_SEPARATOR);
}

/** Whether every slot's file, when it has one, parses as JSON. */
function parseSlots(
  slots: readonly JsonLayer[],
): Result<readonly (JsonValue | undefined)[], string> {
  const values: (JsonValue | undefined)[] = [];
  for (const slot of slots) {
    if (slot.bytes === undefined) {
      values.push(undefined);
      continue;
    }
    const parsed = parseJsonBytes(slot.bytes);
    if (parsed === undefined) {
      return { ok: false, error: `not valid JSON: ${slot.repoPath}` };
    }
    values.push(parsed);
  }
  return { ok: true, value: values };
}

/** The value at an object-key path, or undefined when the path leaves objects. */
function valueAt(
  root: JsonValue | undefined,
  segments: readonly string[],
): JsonValue | undefined {
  let current = root;
  for (const segment of segments) {
    if (current === undefined || current.kind !== "object") {
      return undefined;
    }
    current = current.entries.get(segment);
  }
  return current;
}

/** Whether `root` holds every key of `segments`, each inside an object. */
function hasKeyPath(
  root: JsonValue | undefined,
  segments: readonly string[],
): boolean {
  let current = root;
  for (const segment of segments) {
    if (current === undefined || current.kind !== "object") {
      return false;
    }
    current = current.entries.get(segment);
  }
  return current !== undefined;
}

/** A copy of `root` with the value at `segments` set to `replacement`,
 * creating missing parent objects. An existing key keeps its position. */
function setAt(
  root: JsonValue | undefined,
  segments: readonly string[],
  replacement: JsonValue,
): JsonValue {
  const head = segments[0];
  if (head === undefined) {
    return replacement;
  }
  const entries =
    root !== undefined && root.kind === "object"
      ? new Map(root.entries)
      : new Map<string, JsonValue>();
  entries.set(head, setAt(entries.get(head), segments.slice(1), replacement));
  return { kind: "object", entries };
}

/** A copy of `root` with the value at `segments` removed, keeping the empty
 * parent objects; a path that leaves objects leaves `root` as it is. */
function removeAt(root: JsonValue, segments: readonly string[]): JsonValue {
  const head = segments[0];
  if (head === undefined || root.kind !== "object") {
    return root;
  }
  const entries = new Map(root.entries);
  if (segments.length === 1) {
    entries.delete(head);
    return { kind: "object", entries };
  }
  const child = entries.get(head);
  if (child === undefined) {
    return root;
  }
  entries.set(head, removeAt(child, segments.slice(1)));
  return { kind: "object", entries };
}

function withValue(
  slot: JsonLayer,
  value: JsonValue,
  eol: "\n" | "\r\n",
): JsonLayer {
  return {
    name: slot.name,
    repoPath: slot.repoPath,
    bytes: ENCODER.encode(writeJson(value, eol)),
  };
}

/** Whether a slot between the target and the source sets the key path, so
 * removing it from the source would change the merge. */
function betweenSetsKey(
  values: readonly (JsonValue | undefined)[],
  toIndex: number,
  fromIndex: number,
  segments: readonly string[],
): boolean {
  for (let index = toIndex + 1; index < fromIndex; index++) {
    if (hasKeyPath(values[index], segments)) {
      return true;
    }
  }
  return false;
}

/** Whether a slot between the target and the source holds the array item, so
 * removing it from the source would change the merge. */
function betweenSetsItem(
  values: readonly (JsonValue | undefined)[],
  toIndex: number,
  fromIndex: number,
  segments: readonly string[],
  item: JsonValue,
): boolean {
  for (let index = toIndex + 1; index < fromIndex; index++) {
    const array = valueAt(values[index], segments);
    if (
      array !== undefined &&
      array.kind === "array" &&
      array.items.some((existing) => jsonEqual(existing, item))
    ) {
      return true;
    }
  }
  return false;
}

function rebuild(
  slots: readonly JsonLayer[],
  replacements: ReadonlyMap<number, JsonValue>,
  eol: "\n" | "\r\n",
): readonly JsonLayer[] {
  const result: JsonLayer[] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === undefined) {
      continue;
    }
    const replacement = replacements.get(index);
    result.push(
      replacement === undefined ? slot : withValue(slot, replacement, eol),
    );
  }
  return result;
}

/**
 * Moves one key or array item between two layer slots of a `json` file, per
 * the contract's "Move a change": a move to a narrower layer writes the value
 * into that layer without removing it from the wider one, so the narrower
 * layer overrides it; a move to a wider layer writes it into that layer and
 * removes it from the narrower one, unless a layer in between sets it. The
 * merge of every slot is the same before and after.
 *
 * `path` is the new-setting path: object keys joined with ".", an array item
 * with a trailing "[]"; `item` names the one array item a `kind: "item"` move
 * takes. Slots are in layer order; a slot with no file yet can take the value
 * and gets the file. A source with no value (or no such item) at `path`, a
 * slot that isn't valid JSON, or a layer not among `slots` is an error.
 */
export function moveJsonChange(
  slots: readonly JsonLayer[],
  path: string,
  kind: "key" | "item",
  from: LayerName,
  to: LayerName,
  eol: "\n" | "\r\n",
  item?: JsonValue,
): Result<readonly JsonLayer[], string> {
  const parsed = parseSlots(slots);
  if (!parsed.ok) {
    return parsed;
  }
  const values = parsed.value;
  const fromIndex = slots.findIndex((slot) => slot.name === from);
  const toIndex = slots.findIndex((slot) => slot.name === to);
  if (fromIndex < 0) {
    return { ok: false, error: `no layer ${from}` };
  }
  if (toIndex < 0) {
    return { ok: false, error: `no layer ${to}` };
  }
  if (fromIndex === toIndex) {
    return { ok: true, value: slots };
  }

  if (kind === "item" ? !path.endsWith(ITEM_SUFFIX) : path === "") {
    const what = kind === "item" ? "array item" : "key";
    return { ok: false, error: `not a ${what} path: ${path}` };
  }
  const sourceRoot = values[fromIndex];
  if (sourceRoot === undefined) {
    return { ok: false, error: `no value at ${path}` };
  }
  const segments = segmentsFor(sourceRoot, path, kind);
  const sourceValue = valueAt(sourceRoot, segments);
  if (sourceValue === undefined) {
    return { ok: false, error: `no value at ${path}` };
  }

  const targetRoot = values[toIndex];
  const wider = toIndex < fromIndex;
  const replacements = new Map<number, JsonValue>();

  if (kind === "key") {
    // Narrower: the target is later in the merge, so its value wins; merge it
    // under the source value to keep the merged result and fill what it lacks.
    // Wider: the source value wins over the target's, so merge it on top to
    // keep keys only the target holds.
    const targetValue = valueAt(targetRoot, segments);
    const written =
      targetValue === undefined
        ? sourceValue
        : wider
          ? mergeJsonValues([targetValue, sourceValue])
          : mergeJsonValues([sourceValue, targetValue]);
    replacements.set(toIndex, setAt(targetRoot, segments, written));
    if (wider && !betweenSetsKey(values, toIndex, fromIndex, segments)) {
      replacements.set(fromIndex, removeAt(sourceRoot, segments));
    }
  } else {
    if (
      item === undefined ||
      sourceValue.kind !== "array" ||
      !sourceValue.items.some((existing) => jsonEqual(existing, item))
    ) {
      return { ok: false, error: `no value at ${path}` };
    }
    const targetArray = valueAt(targetRoot, segments);
    const existing =
      targetArray !== undefined && targetArray.kind === "array"
        ? targetArray.items
        : [];
    if (!existing.some((other) => jsonEqual(other, item))) {
      replacements.set(
        toIndex,
        setAt(targetRoot, segments, {
          kind: "array",
          items: [...existing, item],
        }),
      );
    }
    if (wider && !betweenSetsItem(values, toIndex, fromIndex, segments, item)) {
      replacements.set(
        fromIndex,
        setAt(sourceRoot, segments, {
          kind: "array",
          items: sourceValue.items.filter((other) => !jsonEqual(other, item)),
        }),
      );
    }
  }

  return { ok: true, value: rebuild(slots, replacements, eol) };
}

/**
 * Moves a whole file (or an `import` side file) from one layer slot to
 * another: the target slot takes the source's bytes and the source becomes
 * empty, so the next export sees no file there.
 */
export function moveWholeFile(
  slots: readonly JsonLayer[],
  from: LayerName,
  to: LayerName,
): Result<readonly JsonLayer[], string> {
  const fromIndex = slots.findIndex((slot) => slot.name === from);
  const toIndex = slots.findIndex((slot) => slot.name === to);
  if (fromIndex < 0) {
    return { ok: false, error: `no layer ${from}` };
  }
  if (toIndex < 0) {
    return { ok: false, error: `no layer ${to}` };
  }
  if (fromIndex === toIndex) {
    return { ok: true, value: slots };
  }
  const source = slots[fromIndex];
  if (source === undefined) {
    return { ok: false, error: `no layer ${from}` };
  }
  if (source.bytes === undefined) {
    return { ok: false, error: `no file in ${from}` };
  }
  // The narrowest file wins: a narrower target that already has one, or a
  // file between a wider target and the source, would change the result.
  const wider = toIndex < fromIndex;
  if (
    !wider &&
    slots
      .slice(fromIndex + 1, toIndex + 1)
      .some((slot) => slot.bytes !== undefined)
  ) {
    return { ok: false, error: `a layer narrower than ${from} has the file` };
  }
  const keepSource =
    wider &&
    slots
      .slice(toIndex + 1, fromIndex)
      .some((slot) => slot.bytes !== undefined);
  const bytes = source.bytes;
  const result: JsonLayer[] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot === undefined) {
      continue;
    }
    if (index === fromIndex) {
      result.push(
        keepSource
          ? slot
          : { name: slot.name, repoPath: slot.repoPath, bytes: undefined },
      );
    } else if (index === toIndex) {
      result.push({ name: slot.name, repoPath: slot.repoPath, bytes });
    } else {
      result.push(slot);
    }
  }
  return { ok: true, value: result };
}
