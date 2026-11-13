import type { Result } from "../config/types.ts";

const NO_LAYER = "no layer holds the file";

const LAYER_PLACEHOLDER = "{layer}";

/** The line that starts the import block: everything below it is the engine's. */
export const IMPORT_MARKER =
  "<!-- mksync: layers below are written by mksync pull -->";

/**
 * One layer's slot for an `import` entry, in layer order (base first). The
 * label is what replaces `{layer}` in the import name; the base's label is
 * never used. `bytes` undefined means the layer holds no file.
 */
export interface ImportLayer {
  readonly label: string;
  readonly repoPath: string;
  readonly bytes: Uint8Array | undefined;
}

interface ImportSideFile {
  readonly name: string;
  readonly repoPath: string;
  readonly bytes: Uint8Array;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function foldEol(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function toEol(text: string, eol: "\n" | "\r\n"): string {
  return eol === "\n" ? text : text.replaceAll("\n", "\r\n");
}

function isPresent(
  layer: ImportLayer,
): layer is ImportLayer & { readonly bytes: Uint8Array } {
  return layer.bytes !== undefined;
}

function laterPresent(
  layers: readonly ImportLayer[],
): readonly (ImportLayer & { readonly bytes: Uint8Array })[] {
  return layers.slice(1).filter(isPresent);
}

function sideName(importName: string, label: string): string {
  return importName.replaceAll(LAYER_PLACEHOLDER, label);
}

/** The block's lines, in layer order; none when no later layer holds a file. */
function blockLines(
  later: readonly ImportLayer[],
  importName: string,
): readonly string[] {
  return later.length === 0
    ? []
    : [
        IMPORT_MARKER,
        ...later.map((layer) => `@${sideName(importName, layer.label)}`),
      ];
}

/** True when every line after `index` is an `@` line or the final newline. */
function onlyImportLines(lines: readonly string[], index: number): boolean {
  return lines
    .slice(index + 1)
    .every(
      (line, offset, rest) =>
        line.startsWith("@") || (line === "" && offset === rest.length - 1),
    );
}

/**
 * Where the last marker line followed only by `@` lines (and the final
 * newline) starts, or -1 when no marker qualifies. A marker line quoted inside
 * the base text, or followed by any other line, stays base text.
 */
function markerStart(text: string): number {
  const lines = text.split("\n");
  let start = -1;
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === IMPORT_MARKER && onlyImportLines(lines, index)) {
      start = offset;
    }
    offset += line.length + 1;
  }
  return start;
}

/**
 * Pulls an `import` entry: the base text, then, when a later layer holds the
 * file, the marker line and one `@<name>` line per such layer, side files
 * written beside the local file.
 */
export function mergeImport(
  layers: readonly ImportLayer[],
  importName: string,
  eol: "\n" | "\r\n",
): Result<
  {
    readonly local: Uint8Array;
    readonly sideFiles: readonly ImportSideFile[];
  },
  string
> {
  const base = layers[0];
  if (base === undefined || base.bytes === undefined) {
    return { ok: false, error: NO_LAYER };
  }

  const later = laterPresent(layers);
  const block = blockLines(later, importName);

  let text = foldEol(decode(base.bytes));
  if (block.length > 0) {
    if (!text.endsWith("\n")) {
      text += "\n";
    }
    text += block.map((line) => `${line}\n`).join("");
  }

  const sideFiles = later.map((layer) => ({
    name: sideName(importName, layer.label),
    repoPath: layer.repoPath,
    bytes: encode(toEol(foldEol(decode(layer.bytes)), eol)),
  }));

  return { ok: true, value: { local: encode(toEol(text, eol)), sideFiles } };
}

/**
 * Pushes an `import` entry: the text above the marker is base text; the block
 * is the engine's and is never stored. Side files are exported by the caller
 * as whole files.
 */
export function splitImport(
  local: Uint8Array,
  layers: readonly ImportLayer[],
  importName: string,
): { readonly base: Uint8Array | undefined; readonly blockEdited: boolean } {
  const text = foldEol(decode(local));
  const start = markerStart(text);
  const baseText = start === -1 ? text : text.slice(0, start);

  const baseLayer = layers[0];
  const baseLayerText =
    baseLayer?.bytes === undefined ? "" : foldEol(decode(baseLayer.bytes));
  // Pull ends a base without a trailing newline with one before the block.
  const pulledBaseText =
    start !== -1 && !baseLayerText.endsWith("\n")
      ? `${baseLayerText}\n`
      : baseLayerText;
  const base = baseText === pulledBaseText ? undefined : encode(baseText);

  const expectedBlock = blockLines(laterPresent(layers), importName)
    .map((line) => `${line}\n`)
    .join("");
  const actualBlock = start === -1 ? "" : text.slice(start);

  return { base, blockEdited: actualBlock !== expectedBlock };
}
