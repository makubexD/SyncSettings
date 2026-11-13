import type { Profile } from "../config/profile.ts";
import type { MachineRecord } from "./record.ts";

/**
 * `machine retire` and `profile retire` (contract "Retire", plan decision 7):
 * the pure rules. Nothing here reads or writes a file; the caller writes the
 * value when one comes back. Retiring only sets `retired: true`; nothing is
 * deleted.
 */

/** The answer to the `[y/N]` question: `y` or `yes`, any case, around
 * spaces. No answer, an empty answer or anything else is no. */
export function isYes(answer: string | undefined): boolean {
  if (answer === undefined) {
    return false;
  }
  const value = answer.trim().toLowerCase();
  return value === "y" || value === "yes";
}

/** The machine question, one space after it and no newline. */
export function machineRetireQuestion(name: string): string {
  return `Retire machine ${name}? It can't push after this. [y/N] `;
}

/** The profile question, one space after it and no newline. */
export function profileRetireQuestion(name: string): string {
  return `Retire profile ${name}? A first run won't offer it after this. [y/N] `;
}

/** What no answer prints. */
export const NOTHING_RETIRED = "Nothing retired.";

/** A retire that changed nothing: the value was already retired. */
export interface RetireDone<T> {
  readonly ok: true;
  readonly code: 0;
  readonly line: string;
  /** The value to write; absent when it was already retired. */
  readonly value?: T;
}

/** A retire the contract refuses, or one that found nothing. */
export interface RetireRefused {
  readonly ok: false;
  readonly code: 1;
  readonly line: string;
}

/** The line to print, the exit code, and the value to write when `ok` and
 * `value` is there. */
export type RetireResult<T> = RetireDone<T> | RetireRefused;

/**
 * `machine retire <name>`: the record must be the one this store has, and a
 * record already retired is left alone (`no write`, exit 0).
 */
export function retireMachine(
  record: MachineRecord | undefined,
  name: string,
): RetireResult<MachineRecord> {
  if (record === undefined || record.name !== name) {
    return {
      ok: false,
      code: 1,
      line: `ERROR: no machine ${name} here; records are shared once the repo is private.`,
    };
  }
  if (record.retired) {
    return {
      ok: true,
      code: 0,
      line: `Machine ${name} is already retired.`,
    };
  }
  return {
    ok: true,
    code: 0,
    line: `Machine ${name} retired.`,
    value: { ...record, retired: true },
  };
}

/**
 * `profile retire <name>`: a profile a non-retired record still uses is
 * refused, naming the first such record; a retired record does not hold it.
 */
export function retireProfile(
  profile: Profile | undefined,
  name: string,
  records: readonly MachineRecord[],
  profilePath: string,
): RetireResult<Profile> {
  if (profile === undefined) {
    return {
      ok: false,
      code: 1,
      line: `ERROR: profile ${name} not found: ${profilePath}`,
    };
  }
  const user = records.find(
    (record) => !record.retired && record.profile === name,
  );
  if (user !== undefined) {
    return {
      ok: false,
      code: 1,
      line: `ERROR: profile ${name} is used by machine ${user.name}; retire or move that machine first.`,
    };
  }
  if (profile.retired) {
    return {
      ok: true,
      code: 0,
      line: `Profile ${name} is already retired.`,
    };
  }
  return {
    ok: true,
    code: 0,
    line: `Profile ${name} retired.`,
    value: { ...profile, retired: true },
  };
}
