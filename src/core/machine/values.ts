import type { Values } from "../values/sanitize.ts";

/** Where a placeholder's value is kept: the profile's values or the
 * machine's. */
export type ValuePlace = "profile" | "machine";

/** The contract's "Values on a machine" table: an account, a name or a job's
 * address goes on the profile, a path goes on the machine. */
export const VALUE_PLACES: Readonly<Record<string, ValuePlace>> = {
  "<YOUR_NAME>": "profile",
  "<YOUR_EMAIL>": "profile",
  "<YOUR_GH_USERNAME>": "profile",
  "<YOUR_GH_ORG>": "profile",
  "<YOUR_WORK_MARKETPLACE>": "profile",
  "<HOME>": "machine",
  "<GH_CLI_PATH>": "machine",
};

/** A `.user-values.json` split between the profile and the machine. */
export interface MovedValues {
  readonly profile: Values;
  readonly machine: Values;
}

/**
 * Where `placeholder` is kept, or `"ask"` when the table doesn't name it and
 * the first run must ask, per the contract's "Values on a machine".
 */
export function placeValue(placeholder: string): ValuePlace | "ask" {
  const place = Object.hasOwn(VALUE_PLACES, placeholder)
    ? VALUE_PLACES[placeholder]
    : undefined;
  return place ?? "ask";
}

/** The answer for a placeholder the table doesn't name; with none, the
 * contract has an empty answer, end of input and `--yes` take 1 = profile. */
function answerPlace(
  answers: Readonly<Record<string, ValuePlace>>,
  placeholder: string,
): ValuePlace {
  const answer = Object.hasOwn(answers, placeholder)
    ? answers[placeholder]
    : undefined;
  return answer ?? "profile";
}

/**
 * Splits a `.user-values.json` by the table, asking nothing: each "ask"
 * placeholder goes where `answers` puts it, and on the profile when there is
 * no answer. Each side keeps the input order. `Object.fromEntries` makes each
 * key an own data property, so a `__proto__` key stays plain data.
 */
export function moveUserValues(
  values: Values,
  answers: Readonly<Record<string, ValuePlace>>,
): MovedValues {
  const profile: [string, string][] = [];
  const machine: [string, string][] = [];
  for (const [placeholder, value] of Object.entries(values)) {
    const place = placeValue(placeholder);
    const side = place === "ask" ? answerPlace(answers, placeholder) : place;
    if (side === "machine") {
      machine.push([placeholder, value]);
    } else {
      profile.push([placeholder, value]);
    }
  }
  return {
    profile: Object.fromEntries(profile),
    machine: Object.fromEntries(machine),
  };
}
