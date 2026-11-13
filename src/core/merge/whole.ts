import type {
  LayerChange,
  LayerFile,
  MergeStrategy,
} from "./types.ts";

const NO_LAYER = "no layer holds the file";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function lastOf(layers: readonly LayerFile[]): LayerFile | undefined {
  return layers[layers.length - 1];
}

/**
 * A whole file: the latest layer's bytes replace the earlier ones, nothing is
 * merged. The line ending never applies here, as whole files are byte copies.
 */
export const WHOLE: MergeStrategy = {
  merge(layers) {
    const layer = lastOf(layers);
    return layer === undefined
      ? { ok: false, error: NO_LAYER }
      : { ok: true, value: layer.bytes };
  },

  split(local, layers, context) {
    const layer = lastOf(layers);
    if (layer === undefined) {
      return { ok: true, value: [{ repoPath: context.writeRepoPath, bytes: local }] };
    }
    const changes: readonly LayerChange[] =
      sameBytes(local, layer.bytes) ? [] : [{ repoPath: layer.repoPath, bytes: local }];
    return { ok: true, value: changes };
  },
};
