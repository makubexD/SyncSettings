import {
  commitExists,
  readCommitStamp,
  readSyncPoint,
  readTreeAt,
} from "../adapters/git.ts";
import type { EntryType, MergeType, Os } from "../core/config/types.ts";
import { selectEntries } from "../core/layers/select.ts";
import { diffText, labelDiff, ownedPaths } from "../core/plan/diff.ts";
import type {
  DiffHeader,
  LastSync,
  OwnedPaths,
  RepoRef,
} from "../core/plan/diff.ts";
import { planExport } from "../core/plan/export.ts";
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

const NO_COMMIT = "ERROR: --diff needs a git repo with a commit.";

const EXPORT_FAILED = "ERROR: the export for the diff failed; see above.";

/** Contract "Diff": the title and the blank lines around it. */
function title(os: Os): string {
  return `\n  SyncSettings -- DIFF (${os})\n\n`;
}

function treeFailure(ref: string): Result {
  return { code: 1, stdout: "", stderr: `ERROR: cannot read ${ref} from git.\n` };
}

/** The type `ownedPaths` reads: a v2 merge type folded to an entry type. */
function ownedType(merge: MergeType): EntryType {
  if (merge === "dir") {
    return "dir";
  }
  return merge === "dconf" ? "dconf" : "file";
}

/** The owned set narrowed by `--only`: the paths the diff labels and counts. */
function narrowOwned(owned: OwnedPaths, only: readonly string[]): OwnedPaths {
  return {
    exact: owned.exact,
    prefixes: owned.prefixes,
    owns: (path) => owned.owns(path) && onlySelected(path, only),
    labelOf: owned.labelOf,
  };
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

/**
 * Contract "Diff", **Program.**: `mksync export --diff` reads `base` (the sync
 * point's tree, or `theirs` without one) and `theirs` (`origin/master` when the
 * ref exists, else `HEAD`) from git objects, plans an export with `base` as the
 * repo side, and applies its writes to a copy of `base` for `mine`. Prints the
 * labels and the header, exits 0 when nothing differs and 3 when something
 * does. It writes nothing: no repo file, no sync point, no `.user-values.json`.
 */
export async function diffExport(
  repoRoot: string,
  stateFolder: string,
  snapshot: Snapshot,
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

  const planned = planExport({ ...snapshot, repoFiles: base });
  if (planned.code !== 0) {
    return {
      code: 1,
      stdout: writeLines(planned.lines),
      stderr: `${EXPORT_FAILED}\n`,
    };
  }

  const mine = appliedTree(base, planned);
  const allOwned = ownedPaths(
    selected.value.map((entry) => ({
      repoPath: primaryRepoPath(entry),
      type: ownedType(entry.entry.merge),
    })),
  );
  const owned =
    only.paths.length === 0 ? allOwned : narrowOwned(allOwned, only.paths);
  const labels = labelDiff({
    owned,
    base,
    theirs,
    mine,
    hasSyncPoint: syncPoint !== undefined,
  });
  const text = diffText(
    labels,
    headerOf(repoRef, repoStamp.short, lastSync),
    snapshot.only.length > 0,
  );
  return {
    code: text.exit,
    stdout: `${title(snapshot.os)}${writeLines(text.lines)}`,
    stderr: "",
  };
}
