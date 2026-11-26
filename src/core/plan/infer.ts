import type { SelectedEntry } from "../layers/select.ts";
import { valueEnv } from "../values/env.ts";
import { inferValues, inferValuesUnique } from "../values/hydrate.ts";
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

/** A value read from a `json` entry's text, unescaped as JSON reads it. */
function jsonValue(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`);
    return typeof parsed === "string" ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Contract "Sanitize and hydrate", "Inference", export: export reads a value
 * only where it can't be a wrong one, since a wrong value would leave the real
 * one unsanitized in the repo. Each file is read by `inferValuesUnique`; every
 * entry that infers a placeholder has to agree; a `json` entry's value is
 * JSON-unescaped; a placeholder whose `defaultEnv` is set takes the
 * environment's value instead. Anything else is not inferred, and the export
 * stops on it as before.
 */
export function exportInferredValues(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
): Values {
  const inferred = new Map<string, string | null>();
  const fromEnv = new Set<string>();
  for (const entry of selected) {
    if (entry.entry.merge === "dir" || entry.entry.merge === "dconf") {
      continue;
    }
    const rules = entry.entry.sanitize ?? [];
    for (const rule of rules) {
      const env =
        rule.defaultEnv === undefined
          ? undefined
          : valueEnv(snapshot.env, snapshot.home, snapshot.os)[rule.defaultEnv];
      if (env !== undefined && env.length > 0) {
        fromEnv.add(rule.placeholder);
      }
    }
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
    const isJson = entry.entry.merge === "json";
    for (const [placeholder, raw] of inferValuesUnique(
      local.bytes,
      repoBytes,
      rules,
    )) {
      const value = raw !== null && isJson ? (jsonValue(raw) ?? null) : raw;
      const known = inferred.get(placeholder);
      inferred.set(
        placeholder,
        known === undefined || known === value ? value : null,
      );
    }
  }
  const values: Record<string, string> = {};
  for (const [placeholder, value] of inferred) {
    if (value !== null && value.length > 0 && !fromEnv.has(placeholder)) {
      values[placeholder] = value;
    }
  }
  return values;
}
