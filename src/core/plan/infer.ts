import type { SelectedEntry } from "../layers/select.ts";
import { inferValues } from "../values/hydrate.ts";
import type { Values } from "../values/sanitize.ts";
import { resolvedLocal } from "./pick.ts";
import type { Snapshot } from "./types.ts";

/**
 * Contract "Sanitize and hydrate", "Inference": the values the machine's own
 * files hold, read against the repo's placeholder text. Each selected entry
 * with rules whose local and repo files both exist contributes, whatever
 * `--only` picks; `dir` and `dconf` entries have no rules to read. The first
 * value found for a placeholder wins. Import and export both call it.
 */
export function inferredValues(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
): Values {
  const inferred = new Map<string, string>();
  for (const entry of selected) {
    if (entry.entry.merge === "dir" || entry.entry.merge === "dconf") {
      continue;
    }
    const rules = entry.entry.sanitize ?? [];
    const source = entry.source;
    if (rules.length === 0 || source === undefined) {
      continue;
    }
    const repoBytes = snapshot.repoFiles.get(source.repoPath);
    const local = snapshot.localFiles.get(
      resolvedLocal(entry.entry, snapshot.os, snapshot.home),
    );
    if (repoBytes === undefined || local?.kind !== "file") {
      continue;
    }
    for (const [placeholder, value] of Object.entries(
      inferValues(local.bytes, repoBytes, rules),
    )) {
      if (!inferred.has(placeholder)) {
        inferred.set(placeholder, value);
      }
    }
  }
  return Object.fromEntries(inferred);
}
