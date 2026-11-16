import type { Result } from "../config/types.ts";
import { jsonEqual, writeJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerName } from "../layers/select.ts";
import { mergeJsonValues, parseJsonBytes } from "../merge/json.ts";
import type { JsonLayer } from "../merge/json.ts";
import { formatLine } from "../status.ts";
import { changeLines, changeMoveSources } from "./changes.ts";
import type { MoveSource } from "./changes.ts";
import type { FileStep, RunPlan, Snapshot } from "./types.ts";

const ENCODER = new TextEncoder();
/** A repo layer file holds LF; the split writes json changes with it. */
const REPO_EOL = "\n";
const WRITE_FAILURE = "cannot write repo file";
const REMOVE_FAILURE = "cannot remove from repo";
const ITEM_SUFFIX = "[]";

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
 * with a trailing "[]"; `keyPath` is the object keys that lead to the changed
 * value (for an item, to the array), which names a key holding a "." as one
 * segment. `item` names the one array item a `kind: "item"` move takes. Slots
 * are in layer order; a slot with no file yet can take the value and gets the
 * file. A source with no value (or no such item) at `keyPath`, a slot that
 * isn't valid JSON, or a layer not among `slots` is an error.
 */
export function moveJsonChange(
  slots: readonly JsonLayer[],
  path: string,
  keyPath: readonly string[],
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
  const sourceValue = valueAt(sourceRoot, keyPath);
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
    const targetValue = valueAt(targetRoot, keyPath);
    const written =
      targetValue === undefined
        ? sourceValue
        : wider
          ? mergeJsonValues([targetValue, sourceValue])
          : mergeJsonValues([sourceValue, targetValue]);
    replacements.set(toIndex, setAt(targetRoot, keyPath, written));
    if (wider && !betweenSetsKey(values, toIndex, fromIndex, keyPath)) {
      replacements.set(fromIndex, removeAt(sourceRoot, keyPath));
    }
  } else {
    if (
      item === undefined ||
      sourceValue.kind !== "array" ||
      !sourceValue.items.some((existing) => jsonEqual(existing, item))
    ) {
      return { ok: false, error: `no value at ${path}` };
    }
    const targetArray = valueAt(targetRoot, keyPath);
    const existing =
      targetArray !== undefined && targetArray.kind === "array"
        ? targetArray.items
        : [];
    if (!existing.some((other) => jsonEqual(other, item))) {
      replacements.set(
        toIndex,
        setAt(targetRoot, keyPath, {
          kind: "array",
          items: [...existing, item],
        }),
      );
    }
    if (wider && !betweenSetsItem(values, toIndex, fromIndex, keyPath, item)) {
      replacements.set(
        fromIndex,
        setAt(sourceRoot, keyPath, {
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

/** The bytes the plan writes to `path`, or undefined when it writes none. */
function plannedBytes(plan: RunPlan, path: string): Uint8Array | undefined {
  for (const step of plan.steps) {
    for (const item of step.actions) {
      if (item.action.kind === "writeRepo" && item.action.path === path) {
        return item.action.bytes;
      }
    }
  }
  return undefined;
}

function sameBytes(
  left: Uint8Array | undefined,
  right: Uint8Array | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (
    left === undefined ||
    right === undefined ||
    left.length !== right.length
  ) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

/**
 * A plan whose writeRepo and removeRepo actions hold the layer slots' new
 * bytes: an action for a slot path is rewritten, a slot the plan did not write
 * gains one with the export planner's status line, and a slot a whole-file
 * move emptied is removed from the repo or dropped from the plan.
 */
function withMovedSlots(
  plan: RunPlan,
  snapshot: Snapshot,
  slots: readonly JsonLayer[],
): RunPlan {
  let steps: FileStep[] = plan.steps.map((step) => ({
    ...step,
    actions: [...step.actions],
  }));
  const lines = [...plan.lines];
  const removedLines = new Set<number>();
  const additions: { readonly path: string; readonly bytes: Uint8Array }[] = [];

  for (const slot of slots) {
    const planned = plannedBytes(plan, slot.repoPath);
    const before = planned ?? snapshot.repoFiles.get(slot.repoPath);
    const bytes = slot.bytes;
    if (sameBytes(before, bytes)) {
      continue;
    }
    const index = steps.findIndex((step) =>
      step.actions.some(
        (item) =>
          item.action.kind === "writeRepo" &&
          item.action.path === slot.repoPath,
      ),
    );
    const plannedStep = steps[index];
    if (
      plannedStep !== undefined &&
      bytes !== undefined &&
      sameBytes(bytes, snapshot.repoFiles.get(slot.repoPath))
    ) {
      // The move put the repo's own bytes back: the write is gone.
      steps.splice(index, 1);
      removedLines.add(plannedStep.line);
      continue;
    }
    if (bytes !== undefined) {
      if (planned === undefined) {
        additions.push({ path: slot.repoPath, bytes });
        continue;
      }
      steps = steps.map((step) => ({
        ...step,
        actions: step.actions.map((item) =>
          item.action.kind === "writeRepo" && item.action.path === slot.repoPath
            ? { ...item, action: { ...item.action, bytes } }
            : item,
        ),
      }));
      continue;
    }
    // The slot is emptied by a whole-file move.
    if (planned === undefined) {
      continue;
    }
    const step = plannedStep;
    if (step === undefined) {
      continue;
    }
    if (snapshot.repoFiles.has(slot.repoPath)) {
      // The file leaves the repo, so the mkdir and chmod that would write it go.
      steps[index] = {
        ...step,
        actions: [
          {
            action: { kind: "removeRepo", path: slot.repoPath },
            failure: REMOVE_FAILURE,
          },
        ],
      };
      lines[step.line] = formatLine("REMOVED", slot.repoPath);
    } else {
      // Only the plan wrote the file: with no write left, the step is gone.
      steps.splice(index, 1);
      removedLines.add(step.line);
    }
  }

  const keptLines: string[] = [];
  const lineMap = new Map<number, number>();
  lines.forEach((line, index) => {
    if (removedLines.has(index)) {
      return;
    }
    lineMap.set(index, keptLines.length);
    keptLines.push(line);
  });
  const movedSteps = steps.map((step) => ({
    ...step,
    line: lineMap.get(step.line) ?? step.line,
  }));
  for (const addition of additions) {
    const word = snapshot.repoFiles.has(addition.path) ? "MODIFIED" : "ADDED";
    const line = keptLines.length;
    keptLines.push(formatLine(word, addition.path));
    movedSteps.push({
      label: addition.path,
      line,
      counted: true,
      actions: [
        {
          action: {
            kind: "writeRepo",
            path: addition.path,
            bytes: addition.bytes,
          },
          failure: WRITE_FAILURE,
        },
      ],
    });
  }
  return { ...plan, steps: movedSteps, lines: keptLines };
}

/**
 * Contract "Move a change": the export plan `plan` with its block line `line`
 * (1-based, as the block numbers it) moved to layer `to`. A json key or array
 * item goes through `moveJsonChange`, a whole file or `import` side file
 * through `moveWholeFile`; the slot bytes they return become the plan's
 * writeRepo and removeRepo actions. A line out of range, or a target layer the
 * entry has no slot for, is an error; the same layer leaves the plan as it is.
 */
export function applyMove(
  plan: RunPlan,
  snapshot: Snapshot,
  line: number,
  to: LayerName,
): Result<RunPlan, string> {
  const sources = changeMoveSources(plan, snapshot);
  const source = sources[line - 1];
  if (line < 1 || source === undefined) {
    return { ok: false, error: `no change on line ${line}` };
  }
  if (to === source.layer) {
    return { ok: true, value: plan };
  }
  // shortcut: a removed setting or file has nothing left to place in another
  // layer, so it can't move; the contract doesn't say (design "Open").
  if (changeLines(plan, snapshot)[line - 1]?.kind === "-") {
    return {
      ok: false,
      error: `change ${line} removes a setting; it can't move.`,
    };
  }
  const slots: JsonLayer[] = source.entry.slots.map((slot) => ({
    name: slot.name,
    repoPath: slot.repoPath,
    bytes:
      plannedBytes(plan, slot.repoPath) ??
      snapshot.repoFiles.get(slot.repoPath),
  }));

  let moved: Result<readonly JsonLayer[], string>;
  if (source.kind === "whole") {
    moved = moveWholeFile(slots, source.layer, to);
  } else {
    const path = source.path;
    if (path === undefined) {
      return { ok: false, error: `no path for the change on line ${line}` };
    }
    moved = moveJsonChange(
      slots,
      path,
      source.keyPath,
      source.kind,
      source.layer,
      to,
      REPO_EOL,
      source.item,
    );
  }
  if (!moved.ok) {
    return moved;
  }
  const order = slots.map((slot) => slot.name);
  const narrower = order.indexOf(to) > order.indexOf(source.layer);
  const result = narrower
    ? sourceAsInRepo(moved.value, source, snapshot)
    : { ok: true as const, value: moved.value };
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: withMovedSlots(plan, snapshot, result.value) };
}

/**
 * Contract "Move a change": a change moved to a narrower group is "left as it
 * was" in the old layer, as the repo holds it, so the machines the new group
 * leaves out don't receive it. The narrower layer overrides it on this
 * machine, so the merge here stays the same.
 */
function sourceAsInRepo(
  slots: readonly JsonLayer[],
  source: MoveSource,
  snapshot: Snapshot,
): Result<readonly JsonLayer[], string> {
  const repoBytes = snapshot.repoFiles.get(source.repoPath);
  const result: JsonLayer[] = [];
  for (const slot of slots) {
    if (slot.name !== source.layer) {
      result.push(slot);
      continue;
    }
    if (source.kind === "whole" || slot.bytes === undefined) {
      result.push({ ...slot, bytes: repoBytes });
      continue;
    }
    const current = parseJsonBytes(slot.bytes);
    const original =
      repoBytes === undefined ? undefined : parseJsonBytes(repoBytes);
    const path = source.path;
    if (current === undefined || path === undefined) {
      return { ok: false, error: `not valid JSON: ${slot.repoPath}` };
    }
    const segments = source.keyPath;
    let reverted: JsonValue;
    if (source.kind === "key") {
      const before = valueAt(original, segments);
      reverted =
        before === undefined
          ? removeAt(current, segments)
          : setAt(current, segments, before);
    } else {
      const item = source.item;
      const array = valueAt(current, segments);
      const before = valueAt(original, segments);
      const keep =
        before !== undefined &&
        before.kind === "array" &&
        item !== undefined &&
        before.items.some((other) => jsonEqual(other, item));
      reverted =
        keep ||
        item === undefined ||
        array === undefined ||
        array.kind !== "array"
          ? current
          : setAt(current, segments, {
              kind: "array",
              items: array.items.filter((other) => !jsonEqual(other, item)),
            });
    }
    result.push(withValue(slot, reverted, REPO_EOL));
  }
  return { ok: true, value: result };
}
