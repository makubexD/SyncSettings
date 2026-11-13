import type { Os } from "../config/types.ts";
import type { MachineRecord } from "./record.ts";

/** What the scan saw on this machine, the other side of every record check. */
export interface MachineIdentity {
  readonly os: Os;
  readonly hostname: string;
  readonly domain: string | null;
}

/** The record checks a command makes, per decision 8. */
export type CheckMode = "push" | "preview" | "pull";

/** The lines a command prints about the record, and whether it stops. */
export interface CheckResult {
  readonly lines: readonly string[];
  readonly stop: boolean;
}

const RETIRED = "this machine is retired.";

const PULL_ONLY = "this machine is pull-only (see mksync machine show).";

const WARNING = "warning: ";

const ERROR = "ERROR: ";

/** A domain as the contract shows it: `none` for `null`. */
function shown(domain: string | null): string {
  return domain === null ? "none" : domain;
}

/** The contract's one sentence per difference, in the order os, hostname,
 * domain. */
function differences(
  record: MachineRecord,
  identity: MachineIdentity,
): readonly string[] {
  const lines: string[] = [];
  if (record.os !== identity.os) {
    lines.push(
      `the record says os ${record.os}, this machine is ${identity.os}.`,
    );
  }
  if (record.hostname !== identity.hostname) {
    lines.push(
      `the record says hostname ${record.hostname}, this machine is ${identity.hostname}.`,
    );
  }
  if (record.domain !== identity.domain) {
    lines.push(
      `the record says domain ${shown(record.domain)}, this machine has ${shown(identity.domain)}.`,
    );
  }
  return lines;
}

function prefixed(prefix: string, lines: readonly string[]): readonly string[] {
  return lines.map((line) => `${prefix}${line}`);
}

function ifLine(record: MachineRecord): string {
  return `If this is a new machine, run: mksync setup --replace ${record.name}`;
}

/** `push`: what stops an export (a retired or pull-only record, or a hostname
 * or domain that moved), with an os difference alone only warning.
 * `preview`: the same as warnings, and retired and pull-only as warnings
 * too. `pull`: the differences as warnings, and neither of the refusals. */
export function checkRecord(
  record: MachineRecord,
  identity: MachineIdentity,
  mode: CheckMode,
): CheckResult {
  const diff = differences(record, identity);

  if (mode === "pull") {
    return diff.length === 0
      ? { lines: [], stop: false }
      : {
          lines: [...prefixed(WARNING, diff), ifLine(record)],
          stop: false,
        };
  }

  if (mode === "preview") {
    const lines: string[] = [];
    if (record.retired) {
      lines.push(`${WARNING}${RETIRED}`);
    }
    if (record.pullOnly) {
      lines.push(`${WARNING}${PULL_ONLY}`);
    }
    lines.push(...prefixed(WARNING, diff));
    if (diff.length > 0) {
      lines.push(ifLine(record));
    }
    return { lines, stop: false };
  }

  if (record.retired) {
    return { lines: [`${ERROR}${RETIRED}`], stop: true };
  }
  if (record.pullOnly) {
    return { lines: [`${ERROR}${PULL_ONLY}`], stop: true };
  }
  const moved =
    record.hostname !== identity.hostname || record.domain !== identity.domain;
  if (moved) {
    return {
      lines: [...prefixed(ERROR, diff), ifLine(record)],
      stop: true,
    };
  }
  return diff.length === 0
    ? { lines: [], stop: false }
    : { lines: [...prefixed(WARNING, diff), ifLine(record)], stop: false };
}
