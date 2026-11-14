import type {
  LayerFile,
  MergeStrategy,
  SplitResult,
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

function result(
  changes: SplitResult["changes"],
  label: string,
): SplitResult {
  return { changes, newSettings: [], sideFiles: [], label };
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
    // The contract compares the sanitized local text with the layer on export;
    // the change keeps the local bytes, which the plan sanitizes before writing.
    const compared =
      context.sanitize === undefined ? local : context.sanitize(local);
    const layer = lastOf(layers);
    if (layer === undefined) {
      return {
        ok: true,
        value: result(
          [{ repoPath: context.writeRepoPath, bytes: local }],
          context.writeRepoPath,
        ),
      };
    }
    const equal =
      context.compare === undefined
        ? sameBytes(layer.bytes, compared)
        : context.compare(layer.bytes, compared);
    return {
      ok: true,
      value: result(
        equal ? [] : [{ repoPath: layer.repoPath, bytes: local }],
        layer.repoPath,
      ),
    };
  },
};
