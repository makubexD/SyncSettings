import type { EntryType } from "../config/types.ts";
import { formatLine } from "../status.ts";
import type { DiffWord } from "../status.ts";
import { ONLY_WARNING } from "./run.ts";
import type { RepoFiles } from "./types.ts";

const DASHES = "  --------------------------------------------------";

const NONE_RECORDED = "none recorded on this machine";

/** Contract "Diff": the file(s) that differ when no sync point is recorded. */
const NO_SYNC_NOTE =
  "No sync is recorded on this machine, so the newer side is unknown.";

const NO_SYNC_HINT = "Run mksync pull or mksync push once to record one.";

const AGREE = "This machine and the repo agree.";

/** The hint for each label, in the contract's order. */
const HINTS: Readonly<Record<DiffLabel, string | undefined>> = {
  IN: "IN: mksync pull takes them.",
  OUT: "OUT: mksync push sends them.",
  BOTH: "BOTH: changed on both sides; merge by hand.",
  "?": undefined,
};

/** A config entry's repo path, type, and the files of its layers. A v1 entry
 * fits as it is; a v2 entry's layer slots are passed one each. */
export interface OwnedEntry {
  readonly repoPath: string;
  readonly type?: EntryType;
  /** The entry's layer files, each folded into the line at `repoPath`. */
  readonly layerPaths?: readonly string[];
}

/**
 * The owned set: the repo paths this OS's entries own. A file or dconf entry
 * owns its `repoPath` exactly, and a dir entry owns its `<repoPath>/` prefix.
 * No entry owns a v1 `<repoPath>.linked/` tree: nothing reads or writes it
 * now, so a sync point's file there is never listed. Each `layerPath` is
 * owned exactly and labels as its entry's `repoPath`.
 */
export interface OwnedPaths {
  /** Paths an entry owns exactly. */
  readonly exact: ReadonlySet<string>;
  /** Folder prefixes an entry owns, each ending in `/`. */
  readonly prefixes: readonly string[];
  /** Whether an entry owns `path`, exactly or under one of its prefixes. */
  owns(path: string): boolean;
  /** The `repoPath` of the entry whose `layerPaths` include `path`, else
   * `path` itself. */
  labelOf(path: string): string;
}

function isOwned(owned: OwnedPaths, path: string): boolean {
  if (owned.exact.has(path)) {
    return true;
  }
  return owned.prefixes.some((prefix) => path.startsWith(prefix));
}

/** Contract "Diff": the paths this OS's entries own, from their repo paths. */
export function ownedPaths(entries: readonly OwnedEntry[]): OwnedPaths {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const type = entry.type ?? "file";
    if (type !== "dir") {
      exact.add(entry.repoPath);
    } else {
      prefixes.push(`${entry.repoPath}/`);
    }
    for (const layerPath of entry.layerPaths ?? []) {
      exact.add(layerPath);
      if (!labels.has(layerPath)) {
        labels.set(layerPath, entry.repoPath);
      }
    }
  }
  const owned: OwnedPaths = {
    exact,
    prefixes,
    owns: (path) => isOwned(owned, path),
    labelOf: (path) => labels.get(path) ?? path,
  };
  return owned;
}

/** The diff's labels, printed by `formatLine` but never in `STATUS_WORDS`. */
export type DiffLabel = DiffWord;

/** One owned path and the one label the contract's table gives it. */
export interface DiffLine {
  readonly label: DiffLabel;
  readonly path: string;
}

/** Everything the label table reads: the owned set, the three trees, and
 * whether `base` is a sync point. A missing path is absent from its map. */
export interface DiffInput {
  readonly owned: OwnedPaths;
  readonly base: RepoFiles;
  readonly theirs: RepoFiles;
  readonly mine: RepoFiles;
  readonly hasSyncPoint: boolean;
}

/** The sync point's short SHA and commit date (`%h (%cs)`). */
export interface LastSync {
  readonly short: string;
  readonly date: string;
}

/** The ref the diff compares: `origin/master` when it exists, else `HEAD`. */
export type RepoRef = "origin/master" | "HEAD";

/** The lines above the status lines: the sync point and the ref compared. */
export interface DiffHeader {
  /** Absent when no sync point is recorded on this machine. */
  readonly lastSync?: LastSync;
  readonly repo: {
    readonly ref: RepoRef;
    readonly short: string;
  };
}

/** The contract's lines after the title, and the exit code they carry. */
export interface DiffText {
  readonly lines: readonly string[];
  readonly exit: 0 | 3;
}

/** Paths sort as bash's `LC_ALL=C sort` sorts them: by code unit. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Whether the two trees hold the same version of `path`; a missing path on
 * both sides counts as the same version. */
function sameVersion(
  first: RepoFiles,
  second: RepoFiles,
  path: string,
): boolean {
  const a = first.get(path);
  const b = second.get(path);
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return sameBytes(a, b);
}

/** The one label the contract's table gives a path. */
function labelFor(
  path: string,
  base: RepoFiles,
  theirs: RepoFiles,
  mine: RepoFiles,
  hasSyncPoint: boolean,
): DiffLabel | undefined {
  if (!hasSyncPoint) {
    return sameVersion(mine, theirs, path) ? undefined : "?";
  }
  const mineSame = sameVersion(mine, base, path);
  const theirsSame = sameVersion(theirs, base, path);
  if (mineSame && theirsSame) {
    return undefined;
  }
  if (mineSame) {
    return "IN";
  }
  if (theirsSame) {
    return "OUT";
  }
  return sameVersion(mine, theirs, path) ? undefined : "BOTH";
}

/** Contract "Diff": the one label an entry's verdicts fold into. */
function foldLabels(labels: readonly DiffLabel[]): DiffLabel {
  if (labels.includes("BOTH")) {
    return "BOTH";
  }
  const hasIn = labels.includes("IN");
  const hasOut = labels.includes("OUT");
  if (hasIn && hasOut) {
    return "BOTH";
  }
  if (hasOut) {
    return "OUT";
  }
  if (hasIn) {
    return "IN";
  }
  return "?";
}

/**
 * Contract "Diff": one line per owned label, sorted by code unit. Each owned
 * path gets the table's verdict, then the paths that label as the same entry
 * fold into one verdict at that label. Without a sync point `theirs` stands in
 * for `base`, and a machine file that differs from the repo reads `?`.
 */
export function labelDiff(input: DiffInput): readonly DiffLine[] {
  const paths = new Set<string>();
  for (const tree of [input.base, input.theirs, input.mine]) {
    for (const path of tree.keys()) {
      if (input.owned.owns(path)) {
        paths.add(path);
      }
    }
  }
  const verdicts = new Map<string, DiffLabel[]>();
  for (const path of paths) {
    const label = labelFor(
      path,
      input.base,
      input.theirs,
      input.mine,
      input.hasSyncPoint,
    );
    if (label === undefined) {
      continue;
    }
    const group = input.owned.labelOf(path);
    const folded = verdicts.get(group);
    if (folded === undefined) {
      verdicts.set(group, [label]);
    } else {
      folded.push(label);
    }
  }
  const lines: DiffLine[] = [];
  for (const [path, labels] of [...verdicts].sort(([a], [b]) =>
    byCodeUnit(a, b),
  )) {
    lines.push({ label: foldLabels(labels), path });
  }
  return lines;
}

/** The hint line, naming only the labels the diff printed. */
function hintLine(labels: readonly DiffLine[]): string {
  const hints: string[] = [];
  for (const label of ["IN", "OUT", "BOTH"] as const) {
    if (!labels.some((line) => line.label === label)) {
      continue;
    }
    const hint = HINTS[label];
    if (hint !== undefined) {
      hints.push(hint);
    }
  }
  return `  ${hints.join(" ")}`;
}

/** The summary the diff prints with a sync point. */
function summaryLine(counts: Readonly<Record<DiffLabel, number>>): string {
  const total = counts.IN + counts.OUT + counts.BOTH;
  return `  ${total} file(s) differ: ${counts.IN} in, ${counts.OUT} out, ${counts.BOTH} both.`;
}

/**
 * Contract "Diff": the lines after the title and the exit code (0 when nothing
 * differs, 3 when something does). The caller prints the title itself. With
 * `onlyGiven`, a label-less diff warns that `--only` reached nothing before the
 * summary; the exit code and counts don't change (contract "Picking files").
 */
export function diffText(
  labels: readonly DiffLine[],
  header: DiffHeader,
  onlyGiven: boolean,
): DiffText {
  const lines: string[] = [];
  lines.push(
    header.lastSync === undefined
      ? `  Last sync  : ${NONE_RECORDED}`
      : `  Last sync  : ${header.lastSync.short} (${header.lastSync.date})`,
  );
  lines.push(`  Repo       : ${header.repo.ref} ${header.repo.short}`);
  lines.push("");
  for (const line of labels) {
    lines.push(formatLine(line.label, line.path));
  }
  if (labels.length > 0) {
    lines.push("");
  }
  if (onlyGiven && labels.length === 0) {
    lines.push(ONLY_WARNING);
  }
  lines.push(DASHES, "");
  if (labels.length === 0) {
    lines.push(`  ${AGREE}`, "");
    return { lines, exit: 0 };
  }
  if (header.lastSync === undefined) {
    lines.push(`  ${labels.length} file(s) differ. ${NO_SYNC_NOTE}`);
    lines.push(`  ${NO_SYNC_HINT}`, "");
    return { lines, exit: 3 };
  }
  const counts: Record<DiffLabel, number> = { IN: 0, OUT: 0, BOTH: 0, "?": 0 };
  for (const line of labels) {
    counts[line.label] += 1;
  }
  lines.push(summaryLine(counts));
  lines.push(hintLine(labels), "");
  return { lines, exit: 3 };
}
