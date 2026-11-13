import type { Os } from "../config/types.ts";
import type { MachineRecord } from "./record.ts";

/** A takeover's new machine identity: the part of the scan a replace reads.
 * A `Scan` from the adapters is assignable to it, so core imports no adapter. */
export interface ReplaceScan {
  readonly os: Os;
  readonly hostname: string;
  readonly domain: string | null;
}

/**
 * Design "Replace and retire": a new machine takes over `old`'s record. It
 * keeps the name, profile, Claude mode, pull-only, the module overrides, the
 * values and the retired flag. The OS, hostname and domain become the new
 * machine's, and the old pair goes to `replaced`, oldest first, when either
 * changed.
 */
export function replaceRecord(
  old: MachineRecord,
  scan: ReplaceScan,
  date: string,
): MachineRecord {
  const moved = old.hostname !== scan.hostname || old.domain !== scan.domain;
  // shortcut: a takeover on the same hostname and domain adds no history
  // entry; the contract doesn't say, pending the design's Open item.
  const replaced = moved
    ? [
        ...old.replaced,
        {
          hostname: old.hostname,
          domain: old.domain,
          date,
        },
      ]
    : old.replaced;
  return {
    ...old,
    os: scan.os,
    hostname: scan.hostname,
    domain: scan.domain,
    replaced,
  };
}
