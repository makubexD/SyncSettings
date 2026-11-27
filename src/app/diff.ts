import {
  commitExists,
  readCommitStamp,
  readSyncPoint,
  readTreeAt,
  textDiff,
} from "../adapters/git.ts";
import type { EntryType, MergeType, Os } from "../core/config/types.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { Layer, SelectedEntry } from "../core/layers/select.ts";
import { onlyRemoves } from "../core/json/removal.ts";
import { parseJsonBytes } from "../core/merge/json.ts";
import { conflictBlock } from "../core/plan/conflict.ts";
import { diffText, labelDiff, ownedPaths } from "../core/plan/diff.ts";
import type {
  DiffHeader,
  DiffLine,
  LastSync,
  OwnedEntry,
  OwnedPaths,
  RepoRef,
} from "../core/plan/diff.ts";
import { exportValueGaps, planExport } from "../core/plan/export.ts";
import {
  newSettingChoices,
  suggestionAnswers,
} from "../core/plan/newsettings.ts";
import {
  onlySelected,
  primaryRepoPath,
  resolveOnly,
  scopeFor,
} from "../core/plan/pick.ts";
import type { RepoFiles, RunPlan, Snapshot } from "../core/plan/types.ts";
import { writeLines } from "./export.ts";
import type { Result } from "./export.ts";

/** The ref the diff compares when the last fetch left `origin/master`. */
const ORIGIN_MASTER = "refs/remotes/origin/master";

/** What the header calls that ref. */
const ORIGIN_MASTER_NAME = "origin/master";

const HEAD = "HEAD";

/** Where the files the repo tracks for the entries are. */
const DOTFILES_PREFIX = "dotfiles/";

const NO_COMMIT = "ERROR: --diff needs a git repo with a commit.";

const EXPORT_FAILED = "ERROR: the export for the diff failed; see above.";

/** Contract "Diff": the title and the blank lines around it. */
function title(os: Os): string {
  return `\n  SyncSettings -- DIFF (${os})\n\n`;
}

function treeFailure(ref: string): Result {
  return {
    code: 1,
    stdout: "",
    stderr: `ERROR: cannot read ${ref} from git.\n`,
  };
}

/** The type `ownedPaths` reads: a v2 merge type folded to an entry type. */
function ownedType(merge: MergeType): EntryType {
  if (merge === "dir") {
    return "dir";
  }
  return merge === "dconf" ? "dconf" : "file";
}

/**
 * Contract "Diff": what one entry owns. `json` and `import` read several
 * layers at once, so each layer's file counts. Any other entry reads one layer,
 * and `theirs` can read another one than `base`: both count.
 */
function ownedEntries(
  entry: SelectedEntry,
  inTheirs: SelectedEntry | undefined,
): readonly OwnedEntry[] {
  const { merge } = entry.entry;
  const repoPath = primaryRepoPath(entry);
  const own = { repoPath, type: ownedType(merge) };
  if (merge === "json") {
    return [{ ...own, layerPaths: entry.slots.map((slot) => slot.repoPath) }];
  }
  if (merge === "import") {
    const git = entry.slots.filter((slot) => !isPrivate(slot));
    return [{ ...own, layerPaths: git.map((slot) => slot.repoPath) }];
  }
  const theirsPath =
    inTheirs === undefined ? repoPath : primaryRepoPath(inTheirs);
  if (theirsPath === repoPath) {
    return [own];
  }
  return merge === "dir"
    ? [own, { ...own, repoPath: theirsPath }]
    : [{ ...own, layerPaths: [theirsPath] }];
}

/** The owned set narrowed by `--only`: the paths the diff labels and counts. */
function narrowOwned(owned: OwnedPaths, only: readonly string[]): OwnedPaths {
  return {
    exact: owned.exact,
    prefixes: owned.prefixes,
    owns: (path) => owned.owns(path) && onlySelected(owned.labelOf(path), only),
    labelOf: owned.labelOf,
  };
}

/** A layer stored in local state, which no git tree holds. */
function isPrivate(slot: Layer): boolean {
  return slot.name === "profile" || slot.name === "machine";
}

/**
 * Contract "Diff": a `json` entry's profile and machine layers are stored
 * outside git, so the snapshot's copies join both sides of the comparison.
 * Other merge types never gain a private file. Each call returns a fresh map;
 * the given tree is never changed.
 */
function withPrivateLayers(
  tree: RepoFiles,
  selected: readonly SelectedEntry[],
  repoFiles: RepoFiles,
): RepoFiles {
  const copy = new Map(tree);
  for (const entry of selected) {
    if (entry.entry.merge !== "json") {
      continue;
    }
    for (const slot of entry.slots) {
      if (!isPrivate(slot)) {
        continue;
      }
      const bytes = repoFiles.get(slot.repoPath);
      if (bytes !== undefined) {
        copy.set(slot.repoPath, bytes);
      }
    }
  }
  return copy;
}

/**
 * `mine`: `base` with the export's repo writes applied in memory. Only the
 * repo files are touched, so a path the export doesn't mention still equals
 * `base`, as the contract requires.
 */
function appliedTree(base: RepoFiles, plan: RunPlan): RepoFiles {
  const tree = new Map(base);
  for (const step of plan.steps) {
    for (const { action } of step.actions) {
      if (action.kind === "writeRepo") {
        tree.set(action.path, action.bytes);
      } else if (action.kind === "removeRepo") {
        tree.delete(action.path);
      }
    }
  }
  return tree;
}

/**
 * The export plan for `files`. The diff never asks, so a new setting takes the
 * suggestion, as `--yes` does; the plan is made again with those answers.
 */
function planSuggested(snapshot: Snapshot, files: RepoFiles): RunPlan {
  const atFiles = { ...snapshot, repoFiles: files };
  const first = planExport(atFiles);
  const settings = first.newSettings ?? [];
  const question =
    settings.length > 0
      ? newSettingChoices(snapshot.record, snapshot.os)
      : undefined;
  return question === undefined
    ? first
    : planExport(atFiles, suggestionAnswers(settings, question));
}

/** Whether every file was planned: an `ERROR` file leaves `mine` unknown. */
function planned(plan: RunPlan): boolean {
  return plan.code === 0 && plan.errorLines === undefined;
}

/**
 * Contract "Diff": the labels of the `json` entries whose local file is what
 * `theirs` already builds. The same change can sit in other layers there than
 * the ones an export would pick, so no layer file alone shows it.
 */
function settledLabels(
  snapshot: Snapshot,
  theirs: RepoFiles,
  jsonEntries: readonly SelectedEntry[],
): ReadonlySet<string> {
  const plan = planSuggested(snapshot, theirs);
  if (!planned(plan)) {
    return new Set();
  }
  const after = appliedTree(theirs, plan);
  const settled = jsonEntries.filter(({ slots }) =>
    slots.every(({ repoPath }) =>
      sameFile(after.get(repoPath), theirs.get(repoPath)),
    ),
  );
  return new Set(settled.map(primaryRepoPath));
}

function sameFile(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  return a === undefined || b === undefined
    ? a === b
    : Buffer.compare(a, b) === 0;
}

function removesOnly(
  before: Uint8Array,
  after: Uint8Array | undefined,
): boolean {
  if (after === undefined) {
    return true;
  }
  const old = parseJsonBytes(before);
  const now = parseJsonBytes(after);
  return old !== undefined && now !== undefined && onlyRemoves(old, now);
}

/**
 * Contract "Diff": a private layer has no history, so what it holds and the
 * local file lacks may never have been applied here. Such a layer file goes
 * back to its stored version: when the export would only remove from it, or
 * when the local file is what git's layers alone build.
 */
function withoutUnapplied(
  mine: RepoFiles,
  base: RepoFiles,
  jsonEntries: readonly SelectedEntry[],
  gitUnchanged: (path: string) => boolean,
): RepoFiles {
  const tree = new Map(mine);
  for (const { slots } of jsonEntries) {
    const untouched = slots.every(({ repoPath }) => gitUnchanged(repoPath));
    for (const slot of slots) {
      const stored = base.get(slot.repoPath);
      if (!isPrivate(slot) || stored === undefined) {
        continue;
      }
      if (untouched || removesOnly(stored, mine.get(slot.repoPath))) {
        tree.set(slot.repoPath, stored);
      }
    }
  }
  return tree;
}

function headerOf(
  repoRef: RepoRef,
  short: string,
  lastSync: LastSync | undefined,
): DiffHeader {
  return {
    ...(lastSync !== undefined ? { lastSync } : {}),
    repo: { ref: repoRef, short },
  };
}

/** What the conflict blocks are read from. */
export interface ConflictInput {
  readonly labels: readonly DiffLine[];
  readonly owned: OwnedPaths;
  readonly theirs: RepoFiles;
  readonly mine: RepoFiles;
  /** The paths of layers kept in local state, never printed. */
  readonly privatePaths: ReadonlySet<string>;
}

/**
 * Contract "Conflict block": the blocks of the `BOTH` labels, in label order,
 * one per `dotfiles/` file of the label where the two sides differ. A file git
 * can't diff keeps its header lines, so the refusal it explains still prints.
 */
export async function conflictLines(
  input: ConflictInput,
): Promise<readonly string[]> {
  const { owned, theirs, mine } = input;
  const all = [...new Set([...theirs.keys(), ...mine.keys()])]
    .filter(
      (path) =>
        path.startsWith(DOTFILES_PREFIX) &&
        !input.privatePaths.has(path) &&
        owned.owns(path) &&
        !sameFile(theirs.get(path), mine.get(path)),
    )
    .sort();
  const paths = input.labels
    .filter(({ label }) => label === "BOTH")
    .flatMap(({ path: label }) =>
      all.filter((path) => owned.labelOf(path) === label),
    );
  const lines: string[] = [];
  // One git at a time: a conflict list is short, and its length is unbounded.
  for (const path of paths) {
    const before = theirs.get(path);
    const after = mine.get(path);
    const diff = await textDiff(before, after);
    const sides = { theirs: before !== undefined, mine: after !== undefined };
    lines.push(...conflictBlock(path, sides, diff ?? ""));
  }
  return lines;
}

/**
 * Contract "Diff", **Program.**: `mksync export --diff` reads `base` (the sync
 * point's tree, or `theirs` without one) and `theirs` (`origin/master` when the
 * ref exists, else `HEAD`) from git objects, plans an export with `base` as the
 * repo side, and applies its writes to a copy of `base` for `mine`. Prints the
 * labels and the header, exits 0 when nothing differs and 3 when something
 * does. It writes nothing: no repo file, no sync point, no `.user-values.json`.
 * The result's `diff` carries the labels, and the conflict blocks when
 * `conflicts` asks for them; the text is the same either way.
 */
export async function diffExport(
  repoRoot: string,
  stateFolder: string,
  snapshot: Snapshot,
  conflicts = false,
): Promise<Result> {
  const [headStamp, syncPoint, hasOrigin] = await Promise.all([
    readCommitStamp(repoRoot, HEAD),
    readSyncPoint(repoRoot, stateFolder),
    commitExists(repoRoot, ORIGIN_MASTER),
  ]);
  if (headStamp === undefined) {
    return { code: 1, stdout: "", stderr: `${NO_COMMIT}\n` };
  }

  const repoRef: RepoRef = hasOrigin ? "origin/master" : "HEAD";
  const [repoStamp, theirs] = await Promise.all([
    hasOrigin
      ? readCommitStamp(repoRoot, ORIGIN_MASTER_NAME)
      : Promise.resolve(headStamp),
    readTreeAt(repoRoot, repoRef),
  ]);
  if (repoStamp === undefined) {
    return treeFailure(ORIGIN_MASTER_NAME);
  }
  if (theirs === undefined) {
    return treeFailure(repoRef);
  }

  let base = theirs;
  let lastSync: LastSync | undefined;
  if (syncPoint !== undefined) {
    const [stamp, tree] = await Promise.all([
      readCommitStamp(repoRoot, syncPoint),
      readTreeAt(repoRoot, syncPoint),
    ]);
    if (stamp === undefined || tree === undefined) {
      return treeFailure(syncPoint);
    }
    base = tree;
    lastSync = { short: stamp.short, date: stamp.date };
  }

  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(base.keys()),
  );
  if (!selected.ok) {
    return {
      code: selected.error.code,
      stdout: "",
      stderr: `${selected.error.message}\n`,
    };
  }
  // As the entry points do, `--only` is resolved before any tree is compared.
  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return {
      code: only.plan.code,
      stdout: writeLines(only.plan.lines),
      stderr: "",
    };
  }

  const baseTree = withPrivateLayers(base, selected.value, snapshot.repoFiles);
  const theirsTree = withPrivateLayers(
    theirs,
    selected.value,
    snapshot.repoFiles,
  );

  // Contract "Diff": a file whose placeholder has no value is left out of
  // every export plan here, as the preview leaves it out, and printed
  // `SKIPPED`; sanitizing it with a stand-in would give a wrong label. The
  // gaps cover every entry, since some plans below run without `--only`.
  const allGaps = exportValueGaps({
    ...snapshot,
    only: [],
    repoFiles: baseTree,
  });
  const gapLabels = new Set(allGaps.map((gap) => gap.label));
  const scoped: Snapshot =
    allGaps.length === 0
      ? snapshot
      : { ...snapshot, skip: [...(snapshot.skip ?? []), ...gapLabels] };

  const exportPlan = planSuggested(scoped, baseTree);
  if (!planned(exportPlan)) {
    return {
      code: 1,
      // A plan that stopped has only its message; else only the failed files.
      stdout: writeLines(exportPlan.errorLines ?? exportPlan.lines),
      stderr: `${EXPORT_FAILED}\n`,
    };
  }

  // What the export would write with no private layer at all. `--only` was
  // resolved above and can name a label git's layers alone don't have here.
  const gitPlan = planSuggested({ ...scoped, only: [] }, base);
  const gitMine = appliedTree(base, gitPlan);
  const jsonEntries = selected.value.filter(
    ({ entry }) => entry.merge === "json",
  );
  const mine = withoutUnapplied(
    appliedTree(baseTree, exportPlan),
    baseTree,
    jsonEntries,
    (path) => planned(gitPlan) && sameFile(gitMine.get(path), base.get(path)),
  );
  const selectedTheirs = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(theirs.keys()),
  );
  if (!selectedTheirs.ok) {
    return {
      code: selectedTheirs.error.code,
      stdout: "",
      stderr: `${selectedTheirs.error.message}\n`,
    };
  }
  const allOwned = ownedPaths(
    selected.value.flatMap((entry, index) =>
      ownedEntries(entry, selectedTheirs.value[index]),
    ),
  );
  const owned =
    only.paths.length === 0 ? allOwned : narrowOwned(allOwned, only.paths);
  const verdicts = labelDiff({
    owned,
    base: baseTree,
    theirs: theirsTree,
    mine,
    hasSyncPoint: syncPoint !== undefined,
  });
  // Only a `BOTH` can be settled: its export changed the base, so the local
  // file was there to compare.
  const settled = verdicts.some(({ label }) => label === "BOTH")
    ? settledLabels(
        { ...scoped, only: [] },
        theirsTree,
        jsonEntries,
      )
    : new Set<string>();
  const gaps = allGaps.filter((gap) => owned.owns(gap.label));
  const labels = verdicts.filter(
    ({ label, path }) =>
      !gapLabels.has(path) && (label !== "BOTH" || !settled.has(path)),
  );
  const text = diffText(
    labels,
    headerOf(repoRef, repoStamp.short, lastSync),
    snapshot.only.length > 0,
    gaps,
  );
  // Outside `json`, the local file can hold a private layer's content.
  const privatePaths = new Set(
    selected.value.flatMap(({ entry, slots }) => {
      const overridden =
        entry.merge !== "json" &&
        slots.some(
          (slot) => isPrivate(slot) && snapshot.repoFiles.has(slot.repoPath),
        );
      return slots
        .filter((slot) => overridden || isPrivate(slot))
        .map(({ repoPath }) => repoPath);
    }),
  );
  return {
    code: text.exit,
    stdout: `${title(snapshot.os)}${writeLines(text.lines)}`,
    stderr: "",
    diff: {
      labels,
      skipped: gaps,
      conflictLines: conflicts
        ? await conflictLines({
            labels,
            owned,
            theirs: theirsTree,
            mine,
            privatePaths,
          })
        : [],
    },
  };
}
