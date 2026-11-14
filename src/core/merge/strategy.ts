import type { MergeType } from "../config/types.ts";
import { mergeImport, splitImport } from "./import.ts";
import type { ImportLayer } from "./import.ts";
import { mergeJson, splitJson } from "./json.ts";
import type { JsonLayer } from "./json.ts";
import type {
  LayerFile,
  MergeStrategy,
  SideFile,
  SplitResult,
} from "./types.ts";
import { WHOLE } from "./whole.ts";

const IMPORT_NAME_NOTE = "needs {layer} in importName";

const IMPORT_BLOCK_NOTE = "import block is written by mksync, edit not pushed";

const LAYER_PLACEHOLDER = "{layer}";

function importLayers(layers: readonly LayerFile[]): readonly ImportLayer[] {
  return layers.map((layer) => ({
    label: layer.label ?? "",
    repoPath: layer.repoPath,
    // A plan that has values puts them back before it asks for a merge or a
    // split, so this is what the layer needs.
    bytes: layer.hydrated ?? layer.bytes,
  }));
}

function sideFiles(
  layers: readonly LayerFile[],
  importName: string,
): readonly SideFile[] {
  return layers.slice(1).map((layer) => ({
    repoPath: layer.repoPath,
    name: importName.replaceAll(LAYER_PLACEHOLDER, layer.label ?? ""),
  }));
}

/**
 * Contract "Layers (program only)", json: a merge merges the layers' values; a
 * split diffs the local file against them, over every slot so a destination can
 * create a layer file, and returns the new settings no layer could take.
 */
const JSON_MERGE: MergeStrategy = {
  merge(layers, context) {
    return mergeJson(layers, context.eol, {
      bytes: context.local,
      localOnlyKeys: context.localOnlyKeys ?? [],
    });
  },

  split(local, layers, context) {
    const existing = new Map(
      layers.map((layer) => [
        layer.repoPath,
        layer.hydrated ?? layer.bytes,
      ]),
    );
    const slots: JsonLayer[] = (context.slots ?? []).map((slot) => ({
      name: slot.name,
      repoPath: slot.repoPath,
      bytes: existing.get(slot.repoPath),
    }));
    const split = splitJson(local, slots, {
      ...(context.destinations !== undefined
        ? { destinations: context.destinations }
        : {}),
      localOnlyKeys: context.localOnlyKeys ?? [],
    });
    if (!split.ok) {
      return split;
    }
    const value: SplitResult = {
      changes: split.value.changes,
      newSettings: split.value.newSettings,
      sideFiles: [],
      label: context.writeRepoPath,
    };
    return { ok: true, value };
  },
};

/**
 * Contract "Layers (program only)", import: a merge builds the local file from
 * the base text and the later layers' side files; a split takes the text above
 * the marker as base text, names each later layer's side file, and notes an
 * edited block.
 */
const IMPORT_MERGE: MergeStrategy = {
  merge(layers, context) {
    const importName = context.importName;
    if (importName === undefined) {
      return { ok: false, error: IMPORT_NAME_NOTE };
    }
    const merged = mergeImport(importLayers(layers), importName, context.eol);
    return merged.ok ? { ok: true, value: merged.value.local } : merged;
  },

  split(local, layers, context) {
    const importName = context.importName;
    if (importName === undefined) {
      return { ok: false, error: IMPORT_NAME_NOTE };
    }
    const split = splitImport(local, importLayers(layers), importName);
    const label = layers[0]?.repoPath ?? context.writeRepoPath;
    const changes: SplitResult["changes"] =
      split.base === undefined
        ? []
        : [{ repoPath: label, bytes: split.base }];
    const value: SplitResult = {
      changes,
      newSettings: [],
      sideFiles: sideFiles(layers, importName),
      label,
      ...(split.blockEdited ? { note: IMPORT_BLOCK_NOTE } : {}),
    };
    return { ok: true, value };
  },
};

/**
 * The strategy for a merge type. `dir` and `dconf` stay with the plans
 * (phase 8), so they have no strategy yet.
 */
export function strategyFor(merge: MergeType): MergeStrategy | undefined {
  switch (merge) {
    case "whole":
      return WHOLE;
    case "json":
      return JSON_MERGE;
    case "import":
      return IMPORT_MERGE;
    case "dconf":
    case "dir":
      return undefined;
    default: {
      const unhandled: never = merge;
      throw new Error(`Unhandled merge type: ${String(unhandled)}`);
    }
  }
}
