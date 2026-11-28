/**
 * `mksync setting move` checks (contract "mksync setting", "Checks"): the
 * `refused:` lines of the first three checks on text bound for the base or an
 * OS layer, after sanitize and before anything is written or asked. The leak
 * scan, the fourth check, runs outside the core. Pure.
 */

import type { Profile } from "../config/profile.ts";
import type { Os } from "../config/types.ts";
import { placeValue } from "../machine/values.ts";
import type { Values } from "../values/sanitize.ts";
import {
  heldProfileValues,
  heldValues,
  reachedGroup,
  sharedWrites,
} from "./profilevalues.ts";
import type { SharedWrite } from "./profilevalues.ts";
import type { RunPlan, Snapshot } from "./types.ts";

/** Placeholder text as sanitize writes it: `<YOUR_NAME>`, `<WORK_X>`. */
const PLACEHOLDER = /<[A-Z][A-Z0-9_]*>/g;

/** A Windows home that starts with a drive: `C:\Users\jdoe`, `C:/Users/jdoe`. */
const DRIVE_HOME = /^([A-Za-z]):[\\/](.*)$/s;

/** A character that continues a path name: a home followed by one is a
 * longer folder, not the home (`/home/ma` in `/home/mark`). */
const PATH_NAME_CHAR = /^[A-Za-z0-9._-]$/;

/** The systems whose file names ignore case. */
const CASE_INSENSITIVE: ReadonlySet<Os> = new Set<Os>(["windows", "macos"]);

/** Check 1: a profile value, named by its placeholder, never by the value. */
function profileValueLines(
  writes: readonly SharedWrite[],
  profile: Profile,
  os: Os,
  label: string,
): string[] {
  const lines: string[] = [];
  for (const write of writes) {
    for (const placeholder of heldProfileValues(
      write.texts,
      profile,
      write.json,
    )) {
      lines.push(
        `refused: ${label} holds a value of profile ${profile.name} (${placeholder}) and would reach ${reachedGroup(write.layer, os)}.`,
        `Leave it in "profile ${profile.name}", or put ${placeholder} in the file instead.`,
      );
    }
  }
  return lines;
}

/**
 * Check 1, for the machine record: a value of this machine, named by its
 * placeholder, never by the value.
 */
function machineValueLines(
  writes: readonly SharedWrite[],
  values: Values,
  os: Os,
  label: string,
): string[] {
  const lines: string[] = [];
  for (const write of writes) {
    for (const placeholder of heldValues(write.texts, values, write.json)) {
      lines.push(
        `refused: ${label} holds a value of this machine (${placeholder}) and would reach ${reachedGroup(write.layer, os)}.`,
        `Leave it in "this machine", or put ${placeholder} in the file instead.`,
      );
    }
  }
  return lines;
}

/**
 * Check 2: a placeholder whose value lives only in `profiles/<p>.json`. A
 * placeholder the value table names has a value on every machine (each
 * profile or record keeps its own), so only one the table leaves to the run,
 * held by this profile, is refused.
 */
function profilePlaceholderLines(
  writes: readonly SharedWrite[],
  profile: Profile,
  label: string,
): string[] {
  const found = new Set<string>();
  for (const write of writes) {
    const text = write.texts[0] ?? "";
    for (const match of text.matchAll(PLACEHOLDER)) {
      const placeholder = match[0];
      if (
        Object.hasOwn(profile.values, placeholder) &&
        placeValue(placeholder) === "ask"
      ) {
        found.add(placeholder);
      }
    }
  }
  return [...found]
    .sort()
    .map(
      (placeholder) =>
        `refused: ${label} holds ${placeholder}, a value of profile ${profile.name}; machines outside it have no value for it.`,
    );
}

/** The ways a text can write `home`: as is, with `\` doubled, and on Windows
 * with `/` for `\` and in Git Bash's form, `/c/Users/jdoe`. */
export function homeForms(home: string, os: Os): readonly string[] {
  const forms = [home, home.replaceAll("\\", "\\\\")];
  if (os !== "windows") {
    return forms;
  }
  forms.push(home.replaceAll("\\", "/"));
  const drive = DRIVE_HOME.exec(home);
  if (drive !== null) {
    const [, letter = "", rest = ""] = drive;
    forms.push(`/${letter.toLowerCase()}/${rest.replaceAll("\\", "/")}`);
  }
  return forms;
}

/** Whether `form` occurs in `text` with no path-name character right after
 * it: the home itself or a path under it, not a longer folder. */
export function holdsHome(text: string, form: string): boolean {
  if (form === "") {
    return false;
  }
  for (
    let at = text.indexOf(form);
    at !== -1;
    at = text.indexOf(form, at + 1)
  ) {
    const next = text[at + form.length];
    if (next === undefined || !PATH_NAME_CHAR.test(next)) {
      return true;
    }
  }
  return false;
}

/** Check 3: this machine's home folder, on every OS. */
function homeLines(
  writes: readonly SharedWrite[],
  home: string,
  os: Os,
  label: string,
): string[] {
  if (home === "") {
    return [];
  }
  const fold = CASE_INSENSITIVE.has(os)
    ? (text: string) => text.toLowerCase()
    : (text: string) => text;
  const forms = homeForms(home, os).map(fold);
  const held = writes.some((write) =>
    write.texts.some((text) => {
      const folded = fold(text);
      return forms.some((form) => holdsHome(folded, form));
    }),
  );
  return held ? [`refused: ${label} holds this machine's home folder.`] : [];
}

/**
 * The `refused:` lines of the first three checks for every write of `plan`
 * bound for the base or an OS layer, in the contract's order: profile values,
 * machine values (`machineValues`, the record's), profile placeholders, the
 * home folder. `label` is `<module> <file> <key>`. A move that writes no
 * shared layer gets none.
 */
export function settingMoveRefusals(
  plan: RunPlan,
  snapshot: Snapshot,
  profile: Profile | undefined,
  machineValues: Values,
  home: string,
  os: Os,
  label: string,
): readonly string[] {
  const writes = sharedWrites(plan, snapshot);
  if (writes.length === 0) {
    return [];
  }
  const lines = [
    ...(profile === undefined
      ? []
      : profileValueLines(writes, profile, os, label)),
    ...machineValueLines(writes, machineValues, os, label),
    ...(profile === undefined
      ? []
      : profilePlaceholderLines(writes, profile, label)),
    ...homeLines(writes, home, os, label),
  ];
  return [...new Set(lines)];
}
