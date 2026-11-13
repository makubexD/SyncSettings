import { placeValue } from "../machine/values.ts";
import { valuesFileText } from "../values/file.ts";
import type { ValueOwner } from "../values/hydrate.ts";
import type { Values } from "../values/sanitize.ts";
import type { Action, Snapshot, WriteMachineValuesAction } from "./types.ts";

/** The profile and machine a missing value could be added to, when a record
 * names them. */
export function valueOwner(snapshot: Snapshot): ValueOwner | undefined {
  const record = snapshot.record;
  if (record === undefined) {
    return undefined;
  }
  return { profile: record.profile, machine: record.name };
}

/**
 * The `writeMachineValues` action for a run with a record: the values this run
 * resolved that the record and profile don't already hold, split by the
 * contract's "Values on a machine" table (`placeValue`). Machine values are
 * appended to the record's values, profile and `ask` values to the profile's,
 * existing entries first in their order. Nothing new means no action.
 */
export function machineValuesWrite(
  snapshot: Snapshot,
  values: Values,
): WriteMachineValuesAction | undefined {
  const record = snapshot.record;
  if (record === undefined) {
    return undefined;
  }
  const profile = snapshot.profile;
  const machineEntries: [string, string][] = [];
  const profileEntries: [string, string][] = [];
  for (const [placeholder, value] of Object.entries(values)) {
    if (
      Object.hasOwn(record.values, placeholder) ||
      (profile !== undefined && Object.hasOwn(profile.values, placeholder))
    ) {
      continue;
    }
    if (placeValue(placeholder) === "machine") {
      machineEntries.push([placeholder, value]);
    } else if (profile !== undefined) {
      profileEntries.push([placeholder, value]);
    } else {
      // shortcut: the store stops first on a missing profile, so a
      // profile-bound value with no profile is unreachable; keep it on the
      // record rather than drop it.
      machineEntries.push([placeholder, value]);
    }
  }
  if (machineEntries.length === 0 && profileEntries.length === 0) {
    return undefined;
  }
  return {
    kind: "writeMachineValues",
    record: {
      ...record,
      values: Object.fromEntries([
        ...Object.entries(record.values),
        ...machineEntries,
      ]),
    },
    ...(profile !== undefined
      ? {
          profile: {
            ...profile,
            values: Object.fromEntries([
              ...Object.entries(profile.values),
              ...profileEntries,
            ]),
          },
        }
      : {}),
  };
}

/**
 * The `prepare` actions that save values (contract "Values on a machine"):
 * `.user-values.json` when the run has no record, `writeMachineValues` when a
 * record gains a value, and nothing otherwise. `save` is the run's check for
 * whether any entry has rules.
 */
export function valuesPrepare(
  snapshot: Snapshot,
  save: boolean,
  values: Values,
): readonly Action[] {
  if (!save) {
    return [];
  }
  if (snapshot.record === undefined) {
    return [{ kind: "writeValues", text: valuesFileText(values) }];
  }
  const write = machineValuesWrite(snapshot, values);
  return write === undefined ? [] : [write];
}
