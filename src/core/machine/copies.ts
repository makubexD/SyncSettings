import type { Profile } from "../config/profile.ts";

/** One key left out of the merge: the copies disagree, so the user picks
 * one of `choices`, in first-seen order. */
export interface CopyQuestion {
  readonly kind: "value" | "destination";
  readonly key: string;
  readonly choices: readonly string[];
}

/** The profile the copies agree on, and the keys they don't. */
export interface MergedProfileCopies {
  readonly profile: Profile;
  readonly questions: readonly CopyQuestion[];
}

interface JoinedField {
  readonly kept: Readonly<Record<string, string>>;
  readonly questions: readonly CopyQuestion[];
}

/** Every module, first seen first, each name once. */
function joinModules(copies: readonly Profile[]): readonly string[] {
  const seen = new Set<string>();
  for (const copy of copies) {
    for (const module of copy.modules) {
      seen.add(module);
    }
  }
  return [...seen];
}

/**
 * A values or destinations record merged key by key: a key every copy that
 * has it agrees on is kept with its first value, a key whose values differ
 * becomes a question and is left out.
 */
function joinField(
  copies: readonly Profile[],
  field: "values" | "destinations",
  kind: CopyQuestion["kind"],
): JoinedField {
  const order: string[] = [];
  const choices = new Map<string, string[]>();
  for (const copy of copies) {
    for (const [key, value] of Object.entries(copy[field])) {
      const values = choices.get(key);
      if (values === undefined) {
        order.push(key);
        choices.set(key, [value]);
      } else if (!values.includes(value)) {
        values.push(value);
      }
    }
  }

  const entries: [string, string][] = [];
  const questions: CopyQuestion[] = [];
  for (const key of order) {
    const values = choices.get(key) ?? [];
    if (values.length === 1) {
      const [value] = values;
      if (value !== undefined) {
        entries.push([key, value]);
      }
    } else {
      questions.push({ kind, key, choices: values });
    }
  }
  return { kept: Object.fromEntries(entries), questions };
}

/**
 * Design Open, "Two copies of one profile": before the switch each machine
 * keeps its own copy of its profile, and the first private push merges them.
 * Modules, values and destinations are joined, and `retired` is true if any
 * copy says so. A value or destination the copies disagree on is not picked:
 * the key is left out of the merged profile and returned as a question.
 * The copies must share a name, and the tuple rules out zero copies.
 */
export function mergeProfileCopies(
  copies: readonly [Profile, ...Profile[]],
): MergedProfileCopies {
  const values = joinField(copies, "values", "value");
  const destinations = joinField(copies, "destinations", "destination");
  return {
    profile: {
      name: copies[0].name,
      modules: joinModules(copies),
      values: values.kept,
      destinations: destinations.kept,
      retired: copies.some((copy) => copy.retired),
    },
    questions: [...values.questions, ...destinations.questions],
  };
}
