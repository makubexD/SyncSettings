import { STATE_FOLDER_ROOTS } from "../guard.ts";
import { changeLines } from "./changes.ts";
import { planExport } from "./export.ts";
import { groupBlock, withoutNewSettings } from "./groups.ts";
import { newSettingChoices } from "./newsettings.ts";
import { profileValueHits, refusedLines } from "./profilevalues.ts";
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
 * Compared case-insensitively, as the guard folds them: a case-insensitive
 * filesystem treats `Profiles/` as `profiles/`.
 */
function isStateFile(path: string): boolean {
  const folded = path.toLowerCase();
  return STATE_FOLDER_ROOTS.some((root) => folded.startsWith(root));
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
 * The status lines before the summary's first blank line, or all of them when
 * it has none.
 */
function statusBody(rendered: readonly string[]): readonly string[] {
  const summaryStart = rendered.indexOf("");
  return summaryStart === -1 ? rendered : rendered.slice(0, summaryStart);
}

/**
 * The export's summary is replaced by the preview's, mirroring the nested
 * export a preview runs: it says how many files would change, or that the repo
 * is up to date, and the preview then says whether anything would be sent.
 * `block` is the grouped block, printed after the body; the caller passes no
 * lines when there is nothing to group.
 */
function previewSummary(
  plan: RunPlan,
  rendered: readonly string[],
  repo: RepoFiles,
  head: RepoFiles,
  block: readonly string[],
): readonly string[] {
  const body = statusBody(rendered);
  const actions = plan.steps.flatMap((step) =>
    step.actions.map((entry) => entry.action),
  );
  const written = writtenCount(actions);
  const differs = differsFromHead(repo, actions, head);
  const lines: string[] = [...body, "", ...block, DASHES, ""];
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
  const settings = exported.newSettings ?? [];
  // The preview never asks: it plans the export again with every new setting
  // answered by the suggestion, so its status lines and summary show the
  // writes `export --yes` would make (contract "New settings", The preview).
  const question =
    settings.length > 0
      ? newSettingChoices(snapshot.record, snapshot.os)
      : undefined;
  const plan =
    question === undefined
      ? exported
      : planExport(
          snapshot,
          new Map(
            settings.map((setting) => [
              setting.path,
              question.suggestion.layer,
            ]),
          ),
        );
  const rendered = renderRun(plan, NO_FAILURES);
  if (rendered.code !== 0) {
    return { actions: [], lines: rendered.lines, code: rendered.code };
  }
  const changes = changeLines(plan, snapshot);
  const lines =
    question === undefined ? changes : withoutNewSettings(changes, settings);
  const block =
    question === undefined
      ? lines.length === 0
        ? []
        : groupBlock(lines, snapshot.record, snapshot.os, "push")
      : groupBlock(
          lines,
          snapshot.record,
          snapshot.os,
          "push",
          settings,
          settings.map(
            () =>
              `goes to: ${question.suggestion.words} (asked by mksync export)`,
          ),
        );
  // Contract "Profile values (program only)": a hit stops the preview with the
  // refused lines after the block, instead of the summary and exit 0.
  const hits = profileValueHits(plan, snapshot, lines);
  const profileName = snapshot.record?.profile ?? snapshot.profile?.name;
  if (hits.length > 0 && profileName !== undefined) {
    return {
      actions: [],
      lines: [
        ...statusBody(rendered.lines),
        "",
        ...block,
        ...refusedLines(hits, profileName, snapshot.os),
      ],
      code: 1,
    };
  }
  return {
    actions: [],
    lines: previewSummary(
      plan,
      rendered.lines,
      workingTree ?? snapshot.repoFiles,
      head,
      block,
    ),
    code: 0,
  };
}
