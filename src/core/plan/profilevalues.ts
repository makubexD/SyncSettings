import type { Os } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import { formsFor } from "../values/sanitize.ts";
import { exportFileLabel, matchExportEntry } from "./changes.ts";
import { OS_TITLES, changeLineNumbers } from "./groups.ts";
import { isJsonEntry, scopeFor } from "./pick.ts";
import type { Profile } from "../config/profile.ts";
import type { ChangeLine, RunPlan, Snapshot } from "./types.ts";

/** One profile value found in a text bound for a shared layer: the change the
 * block numbers it under, the file it would reach, and the placeholder the
 * message names (contract "Profile values (program only)"). */
export interface ProfileValueHit {
  readonly change: number;
  readonly module: string;
  readonly file: string;
  readonly placeholder: string;
  readonly layer: "base" | "os";
}

/** The selection the search needs; injectable so a failed one can be tested. */
type EntrySelector = typeof selectEntries;

const JSON_UNICODE_ESCAPE = /\\u([0-9A-Fa-f]{4})/g;

const JSON_SLASH_ESCAPE = "\\/";

/** A character that continues a token: a value next to one is not a hit. */
const TOKEN_CHAR = /^[A-Za-z0-9_-]$/;

function continuesToken(char: string | undefined): boolean {
  return char !== undefined && TOKEN_CHAR.test(char);
}

/**
 * Whether `form` occurs in `text` as a whole token: the character just before
 * it and the one just after it, when there is one, are not ASCII letters,
 * digits, `-` or `_` (contract "Profile values"). Both are already folded.
 */
export function holdsToken(text: string, form: string): boolean {
  if (form === "") {
    return false;
  }
  for (
    let at = text.indexOf(form);
    at !== -1;
    at = text.indexOf(form, at + 1)
  ) {
    if (
      !continuesToken(text[at - 1]) &&
      !continuesToken(text[at + form.length])
    ) {
      return true;
    }
  }
  return false;
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * JSON text with its `\uXXXX` and `\/` escapes read back to characters, so a
 * value written that way is still found (contract "Profile values (program
 * only)").
 */
function decodedJsonText(text: string): string {
  return text
    .replace(JSON_UNICODE_ESCAPE, (_match: string, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replaceAll(JSON_SLASH_ESCAPE, "/");
}

/**
 * Whether a value appears as a whole token in any layer text in one of the
 * forms the file can hold it in, ignoring case. `texts` is the raw text and, for a JSON entry, its
 * decoded form.
 */
function holdsValue(
  texts: readonly string[],
  value: string,
  json: boolean,
): boolean {
  const forms = formsFor(value, json).map((form) => form.toLowerCase());
  return texts.some((text) => {
    const folded = text.toLowerCase();
    return forms.some((form) => holdsToken(folded, form));
  });
}

/**
 * The number the block prints for the change of `layer`, `module` and `file`
 * whose `what` holds `value` as a whole token, else for the first change of that
 * file; undefined
 * when the block prints none (contract "Profile values (program only)").
 */
function numberOf(
  lines: readonly ChangeLine[],
  numbers: readonly number[],
  layer: "base" | "os",
  module: string,
  file: string,
  value: string,
): number | undefined {
  const folded = value.toLowerCase();
  let first: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (
      line === undefined ||
      line.layer !== layer ||
      line.module !== module ||
      line.file !== file
    ) {
      continue;
    }
    const number = numbers[index];
    if (number === undefined || number === 0) {
      continue;
    }
    if (holdsToken(line.what.toLowerCase(), folded)) {
      return number;
    }
    first ??= number;
  }
  return first;
}

function compareHits(left: ProfileValueHit, right: ProfileValueHit): number {
  if (left.change !== right.change) {
    return left.change - right.change;
  }
  if (left.placeholder < right.placeholder) {
    return -1;
  }
  return left.placeholder > right.placeholder ? 1 : 0;
}

/**
 * The profile as this run saves it: the `writeMachineValues` prepare action's,
 * which holds the values the run inferred, or undefined when the run saves no
 * profile value.
 */
function savedProfile(plan: RunPlan): Profile | undefined {
  for (const action of plan.prepare ?? []) {
    if (action.kind === "writeMachineValues" && action.profile !== undefined) {
      return action.profile;
    }
  }
  return undefined;
}

/**
 * Contract "Profile values (program only)": every non-empty value of the run's
 * profile, with the values the run saves to it, found, ignoring case, in a repo text bound for the base or an OS
 * layer, with the number the block gives its change. Profile and machine layer
 * writes are not searched, and neither are machine values.
 */
export function profileValueHits(
  plan: RunPlan,
  snapshot: Snapshot,
  lines: readonly ChangeLine[],
  select: EntrySelector = selectEntries,
): readonly ProfileValueHit[] {
  const profile = savedProfile(plan) ?? snapshot.profile;
  if (profile === undefined) {
    return [];
  }
  const selected = select(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    // The export plan selects the same entries and stops first, so this can't
    // happen: refuse loudly rather than report no hits.
    throw new Error(
      `profile values: entries can't be selected: ${selected.error.message}`,
    );
  }
  const numbers = changeLineNumbers(lines, snapshot.record, snapshot.os);
  const hits: ProfileValueHit[] = [];
  for (const step of plan.steps) {
    for (const item of step.actions) {
      const action = item.action;
      if (action.kind !== "writeRepo") {
        continue;
      }
      const match = matchExportEntry(selected.value, action.path);
      if (match === undefined) {
        continue;
      }
      const layer = match.layer.name;
      if (layer !== "base" && layer !== "os") {
        continue;
      }
      // An import entry with no `importName` has no label to print; the write
      // still refuses, recorded under its repo path.
      const file =
        exportFileLabel(match.entry, match.layer, action.path) ?? action.path;
      const entry = match.entry.entry;
      const module = entry.module;
      const json = isJsonEntry(entry);
      const text = textOf(action.bytes);
      const texts = json ? [text, decodedJsonText(text)] : [text];
      for (const [placeholder, value] of Object.entries(profile.values)) {
        if (value === "" || !holdsValue(texts, value, json)) {
          continue;
        }
        // A write the block numbers no line for still refuses: dropping the hit
        // would let the value through. Change 0 marks it.
        const change =
          numberOf(lines, numbers, layer, module, file, value) ?? 0;
        hits.push({ change, module, file, placeholder, layer });
      }
    }
  }
  return hits.sort(compareHits);
}

/**
 * The two `refused:` lines a hit prints, naming the group it would reach in
 * lower case: `all machines`, `linux machines` (contract "Profile values
 * (program only)").
 */
export function refusedLines(
  hits: readonly ProfileValueHit[],
  profileName: string,
  os: Os,
): readonly string[] {
  const lines: string[] = [];
  for (const hit of hits) {
    const group =
      hit.layer === "base"
        ? "all machines"
        : `${OS_TITLES[os].toLowerCase()} machines`;
    lines.push(
      `refused: change ${hit.change} (${hit.module} ${hit.file}) holds a value of profile ${profileName} (${hit.placeholder}) and would reach ${group}.`,
      `Move it to "profile ${profileName}", or put ${hit.placeholder} in the file instead.`,
    );
  }
  return lines;
}
