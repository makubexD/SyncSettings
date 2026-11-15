import { same } from "../compare.ts";
import type { CompareOptions } from "../compare.ts";
import { globSource } from "../plan/pick.ts";
import type {
  LayerChange,
  LayerFile,
  MergeStrategy,
  SplitResult,
} from "./types.ts";

const ROOT_SECTION = "/";

const NO_LAYER = "no layer holds the file";

const KEY_SEPARATOR = "\u0000";

/** dconf runs on Linux only, and export compares bytes exactly. */
const BYTE_COMPARE: CompareOptions = {
  os: "linux",
  shared: false,
  sanitized: false,
};

/** One `key=value` line, with the key's name relative to its section. */
export interface DconfKey {
  readonly name: string;
  /** The line as the dump prints it, so a filtered dump stays byte for byte. */
  readonly line: string;
}

/** One `[section]` block, in the order the dump prints it. */
export interface DconfSection {
  /** The name between the brackets: `/` for the entry's own folder. */
  readonly name: string;
  readonly keys: readonly DconfKey[];
}

/** What export finds when it compares its filtered dump with the repo file. */
export type DconfExportStatus =
  | "SKIPPED"
  | "ADDED"
  | "MODIFIED"
  | "UNCHANGED";

export interface DconfExport {
  readonly status: DconfExportStatus;
  /** `dconf dump`'s text filtered by `keys`; empty when `SKIPPED`. */
  readonly text: string;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Parse a `dconf dump` `.ini` text into ordered sections and keys. Blank lines
 * are dconf's section separators, so they carry nothing. A key line before any
 * section header has no section to belong to and is dropped.
 */
export function parseDconf(text: string): readonly DconfSection[] {
  const sections: { name: string; keys: DconfKey[] }[] = [];
  let current: { name: string; keys: DconfKey[] } | undefined;
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      current = { name: line.slice(1, -1), keys: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const equals = line.indexOf("=");
    current.keys.push({
      name: equals === -1 ? line : line.slice(0, equals),
      line,
    });
  }
  return sections;
}

/**
 * Render sections the way `dconf dump` lays them out: one header, its key
 * lines, and a blank line between sections. A section left with no keys is
 * dropped, as is a trailing blank line.
 */
export function renderDconf(sections: readonly DconfSection[]): string {
  const blocks: string[] = [];
  for (const section of sections) {
    if (section.keys.length === 0) {
      continue;
    }
    const lines = section.keys.map((key) => `${key.line}\n`).join("");
    blocks.push(`[${section.name}]\n${lines}`);
  }
  return blocks.join("\n");
}

/**
 * A key's name relative to the entry's `path`: `font-name` in the entry's own
 * folder, `Profiles/abc/label` in a subfolder.
 */
function relativePath(section: DconfSection, key: DconfKey): string {
  return section.name === ROOT_SECTION
    ? key.name
    : `${section.name}/${key.name}`;
}

/**
 * Contract "dconf entries", `keys`: an allowlist of shell globs over a key's
 * relative name, where `*` also matches `/`. A section left with no keys is
 * dropped, and the dump's own order is kept. No keys at all keeps everything.
 */
export function filterKeys(
  dump: string,
  keys?: readonly string[],
): string {
  if (keys === undefined || keys.length === 0) {
    return dump;
  }
  const patterns = keys.map(
    (pattern) => new RegExp(`^${globSource(pattern)}$`),
  );
  const kept = parseDconf(dump).map((section) => ({
    name: section.name,
    keys: section.keys.filter((key) =>
      patterns.some((pattern) => pattern.test(relativePath(section, key))),
    ),
  }));
  return renderDconf(kept);
}

/**
 * Contract "dconf entries", export: the dump filtered by `keys`, compared
 * byte for byte with the repo file. An empty result is `SKIPPED` and never
 * touches the repo file.
 */
export function exportDconf(
  dump: string,
  keys: readonly string[] | undefined,
  repo: Uint8Array | undefined,
): DconfExport {
  const text = filterKeys(dump, keys);
  if (text === "") {
    return { status: "SKIPPED", text };
  }
  if (repo === undefined) {
    return { status: "ADDED", text };
  }
  return {
    status: same(repo, encode(text), BYTE_COMPARE) ? "UNCHANGED" : "MODIFIED",
    text,
  };
}

/**
 * Contract "dconf entries", import: a change only when a key the repo file
 * sets is missing from the machine or holds a different value there. A key
 * only the machine has doesn't count, because `dconf load` leaves it alone.
 */
export function dconfNeedsLoad(repoText: string, dump: string): boolean {
  const machine = new Map<string, string>();
  for (const section of parseDconf(dump)) {
    for (const key of section.keys) {
      machine.set(`${section.name}${KEY_SEPARATOR}${key.name}`, key.line);
    }
  }
  return parseDconf(repoText).some((section) =>
    section.keys.some(
      (key) =>
        machine.get(`${section.name}${KEY_SEPARATOR}${key.name}`) !== key.line,
    ),
  );
}

/**
 * The layers combined the way "Layers" in the design says: one listed key,
 * the latest layer with that key wins. Keys keep the order their first layer
 * lists them in; a section a later layer adds comes after the earlier ones.
 */
function mergeDconfLayers(layers: readonly LayerFile[]): string {
  const sections: { name: string; lines: Map<string, string> }[] = [];
  for (const layer of layers) {
    for (const section of parseDconf(decode(layer.bytes))) {
      let target = sections.find((candidate) => candidate.name === section.name);
      if (target === undefined) {
        target = { name: section.name, lines: new Map() };
        sections.push(target);
      }
      for (const key of section.keys) {
        target.lines.set(key.name, key.line);
      }
    }
  }
  return renderDconf(
    sections.map((section) => ({
      name: section.name,
      keys: [...section.lines].map(([name, line]) => ({ name, line })),
    })),
  );
}

/**
 * Contract "dconf entries". A merge is the text `dconf load` receives, which
 * leaves every key the text doesn't name alone. A split compares the dump,
 * already filtered by `keys`, with the repo file; an empty dump never touches
 * the repo file.
 */
export const DCONF: MergeStrategy = {
  merge(layers) {
    return layers.length === 0
      ? { ok: false, error: NO_LAYER }
      : { ok: true, value: encode(mergeDconfLayers(layers)) };
  },

  split(local, layers, context) {
    const label =
      layers[layers.length - 1]?.repoPath ?? context.writeRepoPath;
    const merged = encode(mergeDconfLayers(layers));
    const changes: LayerChange[] =
      local.length > 0 && !same(merged, local, BYTE_COMPARE)
        ? [{ repoPath: label, bytes: local }]
        : [];
    const value: SplitResult = {
      changes,
      newSettings: [],
      sideFiles: [],
      label,
    };
    return { ok: true, value };
  },
};
