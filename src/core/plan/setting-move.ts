/**
 * `mksync setting move` (contract "mksync setting", `mksync setting move`):
 * one setting, or one whole file, moved into another layer. The source is the
 * narrowest layer that sets the key or holds the file; the move itself is
 * "Move a change", through the same `move.ts` functions `applyMove` uses.
 * Pure: the snapshot in, the plan of the writes out.
 */

import type { Result } from "../config/types.ts";
import { jsonEqual } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { Layer, LayerName, SelectedEntry } from "../layers/select.ts";
import { parseJsonBytes } from "../merge/json.ts";
import type { JsonLayer } from "../merge/json.ts";
import { formatLine } from "../status.ts";
import { fileLabel } from "./changes.ts";
import {
  moveJsonChange,
  moveWholeFile,
  plannedBytes,
  withMovedSlots,
} from "./move.ts";
import { jsonCellText, listedPaths } from "./settings.ts";
import type { ListedPath } from "./settings.ts";
import type { RunPlan, Snapshot } from "./types.ts";

/** A repo layer file holds LF, as `move.ts` writes it. */
const REPO_EOL = "\n";
const REMOVE_FAILURE = "cannot remove from repo";
const WHOLE_FILE = "(whole file)";
/** Contract "mksync setting": a refusal before any plan is exit 2. */
const USAGE_CODE = 2;
/** Contract "mksync setting move": a refused move is exit 1. */
const REFUSED_CODE = 1;

/** A planned move: the writes, the layer it moves from, and the preview's
 * first line. */
export interface SettingMove {
  readonly plan: RunPlan;
  readonly source: LayerName;
  readonly text: string;
}

/** A refusal: the line the command prints and its exit code. */
export interface SettingMoveError {
  readonly line: string;
  readonly code: number;
}

/** The target is already the layer that sets the key or holds the file. */
export interface AlreadyThere {
  readonly already: LayerName;
}

/** The narrowest layer that sets the key: its slot, value and path. */
interface FoundKey {
  readonly layer: Layer;
  readonly value: JsonValue;
  readonly key: string;
  readonly listed: ListedPath;
}

function refused(
  line: string,
  code: number,
): { readonly ok: false; readonly error: SettingMoveError } {
  return { ok: false, error: { line, code } };
}

/** The first layer file that isn't valid JSON, by repo path. */
function invalidLayer(slots: readonly JsonLayer[]): string | undefined {
  return slots.find(
    (slot) =>
      slot.bytes !== undefined && parseJsonBytes(slot.bytes) === undefined,
  )?.repoPath;
}

function slotsOf(
  plan: RunPlan,
  snapshot: Snapshot,
  entry: SelectedEntry,
): JsonLayer[] {
  return entry.slots.map((slot) => ({
    name: slot.name,
    repoPath: slot.repoPath,
    bytes:
      plannedBytes(plan, slot.repoPath) ??
      snapshot.repoFiles.get(slot.repoPath),
  }));
}

/** The narrowest layer whose file sets `key`, as the listing prints it. */
function findKey(
  slots: readonly JsonLayer[],
  entry: SelectedEntry,
  key: string,
): FoundKey | undefined {
  for (let index = entry.slots.length - 1; index >= 0; index--) {
    const layer = entry.slots[index];
    const bytes = slots[index]?.bytes;
    if (layer === undefined || bytes === undefined) {
      continue;
    }
    const value = parseJsonBytes(bytes);
    if (value === undefined) {
      continue;
    }
    const listed = listedPaths(value).get(key);
    if (listed !== undefined) {
      return { layer, value, key, listed };
    }
  }
  return undefined;
}

function valueAt(
  value: JsonValue | undefined,
  keyPath: readonly string[],
): JsonValue | undefined {
  let current = value;
  for (const segment of keyPath) {
    if (current?.kind !== "object") {
      return undefined;
    }
    current = current.entries.get(segment);
  }
  return current;
}

/** The array items a move carries: on a narrower move, the ones the source
 * holds that the target doesn't. */
function itemsToMove(
  slots: readonly JsonLayer[],
  found: FoundKey,
  to: LayerName,
  wider: boolean,
): readonly JsonValue[] {
  const source = valueAt(found.value, found.listed.keyPath);
  if (source?.kind !== "array") {
    return [];
  }
  // A wider move takes every item out of the source, those the target
  // already holds too: the merged result stays the same either way.
  if (wider) {
    return source.items;
  }
  const targetBytes = slots.find((slot) => slot.name === to)?.bytes;
  const target = valueAt(
    targetBytes === undefined ? undefined : parseJsonBytes(targetBytes),
    found.listed.keyPath,
  );
  const held = target?.kind === "array" ? target.items : [];
  return source.items.filter(
    (item) => !held.some((other) => jsonEqual(other, item)),
  );
}

function moveKey(
  slots: readonly JsonLayer[],
  found: FoundKey,
  to: LayerName,
  items: readonly JsonValue[],
): Result<readonly JsonLayer[], string> {
  const { key, listed } = found;
  const from = found.layer.name;
  if (!listed.array || items.length === 0) {
    return moveJsonChange(
      slots,
      key,
      listed.keyPath,
      "key",
      from,
      to,
      REPO_EOL,
    );
  }
  let moved: Result<readonly JsonLayer[], string> = { ok: true, value: slots };
  for (const item of items) {
    if (!moved.ok) {
      break;
    }
    moved = moveJsonChange(
      moved.value,
      key,
      listed.keyPath,
      "item",
      from,
      to,
      REPO_EOL,
      item,
    );
  }
  return moved;
}

/**
 * `withMovedSlots` drops an emptied slot the plan never wrote; a move from an
 * empty plan removes the source file from the repo, so its `REMOVED` line and
 * action are added here, after the entry's other lines.
 */
function withRemovedSources(
  plan: RunPlan,
  snapshot: Snapshot,
  slots: readonly JsonLayer[],
): RunPlan {
  const removed = slots.filter(
    (slot) =>
      slot.bytes === undefined &&
      snapshot.repoFiles.has(slot.repoPath) &&
      !plan.steps.some((step) =>
        step.actions.some(
          (item) =>
            (item.action.kind === "removeRepo" ||
              item.action.kind === "writeRepo") &&
            item.action.path === slot.repoPath,
        ),
      ),
  );
  if (removed.length === 0) {
    return plan;
  }
  const lines = [...plan.lines];
  const steps = [...plan.steps];
  for (const slot of removed) {
    steps.push({
      label: slot.repoPath,
      line: lines.length,
      counted: true,
      actions: [
        {
          action: { kind: "removeRepo", path: slot.repoPath },
          failure: REMOVE_FAILURE,
        },
      ],
    });
    lines.push(formatLine("REMOVED", slot.repoPath));
  }
  return { ...plan, steps, lines };
}

/**
 * Contract "mksync setting move": `key` (as the listing prints it) in the
 * entry whose `file` is `target`, or the whole file when `key` is absent,
 * moved to `to` on top of `plan`. The source is the narrowest layer that sets
 * it; the same layer as `to` is `already`. The errors are the lines the
 * command prints with their exit codes: exit 2 for no entry and a key given
 * or missing for the entry's kind; exit 1 for a layer that isn't valid JSON,
 * no layer setting the key or holding the file, the merged-result refusal,
 * the narrower-file refusal, and a `to` the entry has no slot for. A narrower
 * array move whose target holds every item is `already` too.
 */
export function planSettingMove(
  plan: RunPlan,
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
  target: string,
  key: string | undefined,
  to: LayerName,
): Result<SettingMove | AlreadyThere, SettingMoveError> {
  const entry = selected.find((candidate) => candidate.entry.file === target);
  if (entry === undefined) {
    return refused(`ERROR: no entry ${target} in sync-config.json`, USAGE_CODE);
  }
  const json = entry.entry.merge === "json";
  if (json && key === undefined) {
    return refused(`ERROR: ${target} is a json entry; name a key`, USAGE_CODE);
  }
  if (!json && key !== undefined) {
    return refused(
      `ERROR: ${target} is not a json entry; it moves as a whole file, with no key`,
      USAGE_CODE,
    );
  }
  const slots = slotsOf(plan, snapshot, entry);
  const invalid = json ? invalidLayer(slots) : undefined;
  if (invalid !== undefined) {
    return refused(`ERROR: not valid JSON: ${invalid}`, REFUSED_CODE);
  }
  const found = key === undefined ? undefined : findKey(slots, entry, key);
  // shortcut: a `dir` entry's folder and an `import` side file aren't found
  // by `file` here; they need the listing's per-file names (design "Open").
  const holder =
    key === undefined
      ? entry.slots.findLast((_, index) => slots[index]?.bytes !== undefined)
      : found?.layer;
  if (holder === undefined) {
    return refused(
      key === undefined
        ? `ERROR: no layer holds ${target}`
        : `ERROR: no layer sets ${key} in ${target}`,
      REFUSED_CODE,
    );
  }
  if (holder.name === to) {
    return { ok: true, value: { already: to } };
  }
  const order = slots.map((slot) => slot.name);
  const narrower = order.indexOf(to) > order.indexOf(holder.name);
  const items =
    found === undefined ? [] : itemsToMove(slots, found, to, !narrower);
  if (found?.listed.array === true && narrower && items.length === 0) {
    // The target already holds every item: there is nothing to move.
    return { ok: true, value: { already: to } };
  }
  const moved =
    found === undefined
      ? moveWholeFile(slots, holder.name, to)
      : moveKey(slots, found, to, items);
  if (!moved.ok) {
    return refused(moved.error, REFUSED_CODE);
  }
  // A narrower move leaves the source as the repo holds it, byte for byte.
  const sourceIndex = order.indexOf(holder.name);
  const kept = narrower
    ? moved.value.map((slot, index) =>
        index === sourceIndex ? (slots[index] ?? slot) : slot,
      )
    : moved.value;
  const written = withRemovedSources(
    withMovedSlots(plan, snapshot, kept),
    snapshot,
    kept,
  );
  const label = `${entry.entry.module} ${fileLabel(entry.entry.file)}`;
  const shown =
    found === undefined
      ? WHOLE_FILE
      : `${found.key}: ${jsonCellText(found.value, found.listed) ?? ""}`;
  return {
    ok: true,
    value: {
      plan: written,
      source: holder.name,
      text: `Move ${label} ${shown}`,
    },
  };
}
