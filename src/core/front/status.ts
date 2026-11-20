/**
 * Contract "Front door", `mksync status`: the lines it prints and the next
 * command it suggests. Pure: the app gathers the facts through git, the import
 * check and the diff, and prints the lines this module returns. Mirrors
 * `scripts/linux/front.sh` `front_status`.
 */

import type { Os } from "../config/types.ts";

/** What the status knows about `origin/master`. */
export type OriginFact =
  | { readonly kind: "not-git" }
  | { readonly kind: "no-origin" }
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "offline" }
  | { readonly kind: "fetched"; readonly updates: number };

/**
 * The export diff's split of the differing files, and its summary line as the
 * diff prints it: `<n> file(s) differ: <in> in, <out> out, <both> both`.
 */
export interface DiffSplit {
  readonly summary: string;
  readonly in: number;
  readonly out: number;
  readonly both: number;
}

/**
 * What the import check found. `diff` is set only when a sync point is
 * recorded and the diff ran; it is null with no sync point, a failed diff or a
 * diff that agrees.
 */
export type MachineFact =
  | { readonly kind: "unknown" }
  | { readonly kind: "match" }
  | {
      readonly kind: "differ";
      readonly count: number;
      readonly diff: DiffSplit | null;
    };

/** Everything the status lines and the next command read. */
export interface StatusFacts {
  readonly os: Os;
  /** The pretty OS name the header shows. */
  readonly osName: string;
  /** The repo root. */
  readonly repo: string;
  readonly origin: OriginFact;
  /** Changed files under the sync paths; null when not a git clone. */
  readonly unsent: number | null;
  readonly machine: MachineFact;
  /** A pull-only machine never suggests `mksync push`. */
  readonly pullOnly: boolean;
  /** Linked-folder lines, already worded; empty until step 25. */
  readonly linked: readonly string[];
}

const LABEL_WIDTH = 10;

const DOCTOR = "run mksync doctor.";

const TAKE_REPO_OR_SEND =
  "mksync pull to take the repo's version, or mksync push to send this machine's.";

const FILE_BY_FILE = "mksync diff, then push or pull file by file.";

const MACHINE_UNKNOWN =
  "the machine check failed; run mksync check to see why.";

/** Contract "Front door": the origin line's text. */
function originText(origin: OriginFact): string {
  switch (origin.kind) {
    case "not-git":
      return "not a git clone";
    case "no-origin":
      return "no origin remote";
    case "branch":
      return `on branch ${origin.branch}, not master`;
    case "offline":
      return "offline, not checked";
    case "fetched":
      return origin.updates > 0
        ? `${origin.updates} update(s) waiting`
        : "up to date";
  }
}

/** Contract "Front door": the unsent line's text. */
function unsentText(unsent: number | null): string {
  if (unsent === null) {
    return "not checked";
  }
  if (unsent > 0) {
    return `${unsent} changed file(s) not sent yet`;
  }
  return "none";
}

/** Contract "Front door": the machine line's text. */
function machineText(machine: MachineFact): string {
  switch (machine.kind) {
    case "unknown":
      return "not checked: run mksync check to see why";
    case "match":
      return "matches the repo";
    case "differ":
      return machine.diff === null
        ? `${machine.count} file(s) differ from the repo`
        : machine.diff.summary;
  }
}

/** Contract "Front door": what to do about a machine that differs. */
function differNext(
  machine: Extract<MachineFact, { kind: "differ" }>,
  pullOnly: boolean,
): string {
  const diff = machine.diff;
  if (pullOnly) {
    if (diff !== null && (diff.out > 0 || diff.both > 0)) {
      return "mksync pull --force to take the repo's version (each keeps a .bak).";
    }
    return "mksync pull";
  }
  if (diff === null) {
    return TAKE_REPO_OR_SEND;
  }
  if (diff.both > 0 || (diff.in > 0 && diff.out > 0)) {
    return FILE_BY_FILE;
  }
  if (diff.out > 0) {
    return "mksync push";
  }
  if (diff.in > 0) {
    return "mksync pull";
  }
  return TAKE_REPO_OR_SEND;
}

/**
 * Contract "Front door", status table: the first rule that matches decides.
 * A pull-only machine skips the push rule.
 */
export function nextCommand(f: StatusFacts): string {
  if (f.origin.kind === "not-git" || f.origin.kind === "no-origin") {
    return DOCTOR;
  }
  if (f.origin.kind === "fetched" && f.origin.updates > 0) {
    return "mksync pull";
  }
  if (f.unsent !== null && f.unsent > 0 && !f.pullOnly) {
    return "mksync push";
  }
  if (f.machine.kind === "differ") {
    return differNext(f.machine, f.pullOnly);
  }
  if (f.machine.kind === "unknown") {
    return MACHINE_UNKNOWN;
  }
  return "nothing to do.";
}

/** One labelled status line, as bash `printf '  %-10s: %s\n'` prints it. */
function labelled(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}: ${value}`;
}

/** Contract "Front door": the status output lines, without line endings. */
export function statusLines(f: StatusFacts): string[] {
  return [
    "",
    `  SyncSettings  ${f.os} (${f.osName})`,
    labelled("Repo", f.repo),
    labelled("Origin", originText(f.origin)),
    labelled("Unsent", unsentText(f.unsent)),
    labelled("Machine", machineText(f.machine)),
    ...f.linked.map((line) => `  ${line}`),
    "",
    `  Next: ${nextCommand(f)}`,
  ];
}
