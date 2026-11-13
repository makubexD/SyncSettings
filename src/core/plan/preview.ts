import { STATE_FOLDER_ROOTS } from "../guard.ts";
import { planExport } from "./export.ts";
import { renderRun } from "./run.ts";
import { NO_FAILURES } from "./types.ts";
import type { Action, Plan, RepoFiles, RunPlan, Snapshot } from "./types.ts";

const DASHES = "  --------------------------------------------------";

const ONLY_ERROR = "ERROR: --preview cannot be combined with --only.";

const NO_COMMIT_ERROR = "ERROR: --preview needs a git repo with a commit.";

const MATCHES_HEAD = "  Nothing would be sent: the repo matches HEAD.";

const NOTHING_WRITTEN = "  Nothing was written. Run mksync push to send it.";

/**
 * A profile's or machine's layer files live in the state folder, under the
 * guard's repo path roots. An export writes them, but they are never committed,
 * so they are not part of the comparison with `HEAD` or of the preview's count.
 */
function isStateFile(path: string): boolean {
  return STATE_FOLDER_ROOTS.some((root) => path.startsWith(root));
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

/**
 * Files the export would write to the repo, as a count for the preview's
 * summary. State-folder layer writes are never committed, so they don't count.
 */
function writtenCount(actions: readonly Action[]): number {
  let count = 0;
  for (const action of actions) {
    if (
      (action.kind === "writeRepo" || action.kind === "removeRepo") &&
      !isStateFile(action.path)
    ) {
      count++;
    }
  }
  return count;
}

/**
 * The repo tree after the export: the working tree with its writes and removals
 * applied. State-folder layers are left out, since nothing there is committed.
 */
function exportedTree(repo: RepoFiles, actions: readonly Action[]): RepoFiles {
  const tree = new Map<string, Uint8Array>();
  for (const [path, bytes] of repo) {
    if (!isStateFile(path)) {
      tree.set(path, bytes);
    }
  }
  for (const action of actions) {
    if (action.kind !== "writeRepo" && action.kind !== "removeRepo") {
      continue;
    }
    if (isStateFile(action.path)) {
      continue;
    }
    if (action.kind === "writeRepo") {
      tree.set(action.path, action.bytes);
    } else {
      tree.delete(action.path);
    }
  }
  return tree;
}

/**
 * Contract "Export preview": whether the exported result differs from `HEAD`.
 * The whole committed tree is compared, so changes exported earlier but not yet
 * committed show too; state-folder layers are left out, as they are never
 * committed.
 */
function differsFromHead(
  repo: RepoFiles,
  actions: readonly Action[],
  head: RepoFiles,
): boolean {
  const tree = exportedTree(repo, actions);
  if (tree.size !== head.size) {
    return true;
  }
  for (const [path, bytes] of tree) {
    const committed = head.get(path);
    if (committed === undefined || !sameBytes(committed, bytes)) {
      return true;
    }
  }
  return false;
}

/**
 * The export's summary is replaced by the preview's, mirroring the nested
 * export a preview runs: it says how many files would change, or that the repo
 * is up to date, and the preview then says whether anything would be sent.
 */
function previewSummary(
  plan: RunPlan,
  rendered: readonly string[],
  repo: RepoFiles,
  head: RepoFiles,
): readonly string[] {
  const summaryStart = rendered.indexOf("");
  const body = summaryStart === -1 ? rendered : rendered.slice(0, summaryStart);
  const actions = plan.steps.flatMap((step) =>
    step.actions.map((entry) => entry.action),
  );
  const written = writtenCount(actions);
  const differs = differsFromHead(repo, actions, head);
  const lines: string[] = [...body, "", DASHES, ""];
  lines.push(
    written > 0
      ? `  ${written} file(s) would change.`
      : "  Repo is up to date. No changes detected.",
  );
  if (!differs) {
    lines.push("");
    lines.push(MATCHES_HEAD);
  }
  lines.push(NOTHING_WRITTEN);
  lines.push("");
  return lines;
}

/**
 * The export preview: what a commit would send, from a snapshot and its `HEAD`
 * bytes. `workingTree` is the tree the export is compared against `HEAD`, when
 * the caller has more than the snapshot's repo files holds: it includes
 * `sync-config.json`, which belongs in the comparison but never in the export
 * plan. Without it the snapshot's own repo files are compared. It never
 * returns a write action.
 *
 * shortcut: the leak scan and the `--stat`/diff text belong to the adapter that
 * prints the plan, so the plan carries the status lines and the messages
 * around them; the adapter prints the diff when these lines leave it out.
 */
export function planPreview(snapshot: Snapshot, workingTree?: RepoFiles): Plan {
  if (snapshot.only.length > 0) {
    return { actions: [], lines: [ONLY_ERROR], code: 1 };
  }
  const head = snapshot.headFiles;
  if (head === undefined) {
    return { actions: [], lines: [NO_COMMIT_ERROR], code: 1 };
  }

  const exported = planExport(snapshot);
  const rendered = renderRun(exported, NO_FAILURES);
  if (rendered.code !== 0) {
    return { actions: [], lines: rendered.lines, code: rendered.code };
  }
  return {
    actions: [],
    lines: previewSummary(
      exported,
      rendered.lines,
      workingTree ?? snapshot.repoFiles,
      head,
    ),
    code: 0,
  };
}
