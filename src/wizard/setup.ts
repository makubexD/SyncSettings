import type { Scan } from "../adapters/scan.ts";
import type { LinkedFolder } from "../adapters/store.ts";
import { trimAnswer } from "../core/answer.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, ConfigV2Entry, Os } from "../core/config/types.ts";
import { LAYER_NAME, RESERVED_LAYER_NAMES } from "../core/layers/names.ts";
import {
  LINKED_DESTINATION_PREFIX,
  linkedQuestion,
  linkedSuggestionNumber,
} from "../core/machine/linked.ts";
import type { ClaudeMode, MachineRecord } from "../core/machine/record.ts";
import { replaceRecord } from "../core/machine/replace.ts";

/** The fourth answer: what setup does with files already on the machine. */
export type ExistingAction = "backup" | "keep" | "stop";

/** `--mode`'s values. */
export type SetupMode = "push" | "pull-only";

/** The setup flags, as `mksync setup` parses them. */
export interface SetupFlags {
  readonly name?: string;
  readonly profile?: string;
  readonly replace?: string;
  readonly claude?: ClaudeMode;
  readonly mode?: SetupMode;
  readonly existing?: ExistingAction;
  readonly yes?: boolean;
  readonly bootstrap?: boolean;
}

/** The diff's outcome when it ran: success with its counts and the `OUT` and
 * `BOTH` lines it printed, or a failure that couldn't tell which side is newer. */
export type SetupDiff =
  | {
      readonly ok: true;
      readonly inCount: number;
      readonly outCount: number;
      readonly bothCount: number;
      /** The diff's `OUT` and `BOTH` lines, in the order it printed them. */
      readonly blocked: readonly string[];
    }
  | { readonly ok: false };

/** What the import check and the diff already know, computed by the caller
 * before the flow: the check's `UPDATE` count, whether a sync point is
 * recorded, and the diff's outcome when it ran. A `CREATE` never counts. */
export interface SetupDiffer {
  readonly updates: number;
  readonly hasSyncPoint: boolean;
  /** Present when the diff ran (the check found changes and a sync point
   * exists); absent when nothing told it to run. */
  readonly diff?: SetupDiff;
}

/** Everything the flow reads; it reads nothing else and writes nothing. */
export interface SetupInput {
  readonly scan: Scan;
  readonly config: ConfigV2;
  /** Every profile in the store, retired ones included. */
  readonly profiles: readonly Profile[];
  /** Every record in the store other machines could be taken over from. */
  readonly records: readonly MachineRecord[];
  /** This machine's own record, when it already has one. */
  readonly own?: MachineRecord;
  readonly isPrivate: boolean;
  /** `YYYY-MM-DD`, for a replaced record's history. */
  readonly today: string;
  readonly flags: SetupFlags;
  /** What the import check and the diff already know, for question 4 and the
   * guard block. */
  readonly differ: SetupDiffer;
  /** The Ubuntu bootstrap can run here (an executable `bootstrap/linux.sh` on
   * Ubuntu), so setup asks about it before the summary. */
  readonly bootstrapOffered?: boolean;
  /** The linked folders to ask about, read once through this input: the flow
   * makes no other read and reads nothing by itself. */
  readonly linkedFolders?: (
    profile: Profile,
    record: MachineRecord,
  ) => readonly LinkedFolder[];
}

/** The terminal: text out, one answer line in, `undefined` at end of input. */
export interface SetupIo {
  write(text: string): void;
  readLine(): Promise<string | undefined>;
}

export type SetupOutcome =
  | {
      readonly ok: true;
      readonly record: MachineRecord;
      readonly profile: Profile;
      /** The profile isn't in the store yet and must be written. */
      readonly newProfile: boolean;
      readonly action: ExistingAction;
      /** True when an existing record is taken over, by `--replace` or by
       * choosing the profile the hostname suggests. */
      readonly replaced: boolean;
      /** The bootstrap question was answered `y`, or `--bootstrap` was given. */
      readonly bootstrap: boolean;
    }
  | { readonly ok: false; readonly message: string; readonly code: 1 | 2 }
  /** The confirm was answered no: nothing is written, exit 0. */
  | { readonly ok: false; readonly declined: true };

const PERSONAL = "personal";

const NONE = "none";

/** The profile list pads a name with machines to this width. */
const NAME_COLUMN = 12;

const DIGITS = /^[0-9]+$/;

const CLAUDE_CHOICES: readonly ClaudeMode[] = [
  "none",
  "claude",
  "claude-deepseek",
];

const CLAUDE_LABELS: Readonly<Record<ClaudeMode, string>> = {
  none: "none",
  claude: "Claude only",
  "claude-deepseek": "Claude plus DeepSeek",
};

const MODE_CHOICES: readonly SetupMode[] = ["push", "pull-only"];

const MODE_LABELS: Readonly<Record<SetupMode, string>> = {
  push: "push with a preview",
  "pull-only": "pull only",
};

const EXISTING_CHOICES: readonly ExistingAction[] = ["backup", "keep", "stop"];

const Q1 = "1/4 What is this machine for?";
const Q2 = "2/4 Claude here? 1) none  2) Claude only  3) Claude plus DeepSeek";
const Q3 =
  "3/4 Push with a preview, or pull only? 1) push with a preview  2) pull only";
const Q4 =
  "4/4 Files that are already here? 1) back up and replace  2) keep mine, push them first  3) stop";

/** Contract "Bootstrap": the question setup asks before the summary. */
const BOOTSTRAP_QUESTION =
  "  Also restore apps and packages from packages/linux (uses sudo)? [y/N] ";

/** Contract "Confirm": asked after the summary; nothing is written on a no. */
const CONFIRM_QUESTION = "Write the record and apply? [Y/n] ";

/** Contract "Confirm": after `stop` nothing is applied, so the question drops
 * "and apply"; `stop` never makes a guard block. */
const CONFIRM_STOP_QUESTION = "Write the record? [Y/n] ";

/** Contract "Confirm": after a guard block the default is no. */
const CONFIRM_GUARDED_QUESTION = "Write the record and apply? [y/N] ";

/** The modules a new profile takes for each tool the scan found. */
const TOOL_MODULES: readonly (readonly [string, string])[] = [
  ["gh", "gh"],
  ["code", "vscode"],
  ["claude", "claude"],
  ["tmux", "tmux"],
  ["starship", "starship"],
  ["wezterm", "wezterm"],
  ["htop", "htop"],
  ["rtk", "rtk"],
];

/** A linked folder's `dir` entry sits under its layer's `linked/` folder. */
const LINKED_FOLDER = "linked/";

const LINKED_CHOICES: readonly number[] = [1, 2, 3];

const OS_MODULES: Readonly<Record<Os, readonly string[]>> = {
  linux: ["gnome"],
  windows: ["windows-terminal"],
  macos: [],
};

function stop(message: string, code: 1 | 2): SetupOutcome {
  return { ok: false, message, code };
}

/** Bash's `[Yy]*`: the bootstrap question's yes. */
function isYes(answer: string): boolean {
  return answer.startsWith("y") || answer.startsWith("Y");
}

/** Bash's `[Nn]*`: the confirm's no. */
function isNo(answer: string): boolean {
  return answer.startsWith("n") || answer.startsWith("N");
}

/** Contract "What differs": the line above question 4, or undefined when
 * nothing differs (a count of 0 prints no line). */
function differLine(differ: SetupDiffer): string | undefined {
  if (!differ.hasSyncPoint) {
    return differ.updates === 0
      ? undefined
      : `  ${differ.updates} file(s) differ. No sync is recorded on this machine, so the newer side is unknown.`;
  }
  if (differ.diff === undefined) {
    return undefined;
  }
  if (!differ.diff.ok) {
    return differ.updates === 0
      ? undefined
      : `  ${differ.updates} file(s) differ; could not tell which side is newer.`;
  }
  const count =
    differ.diff.inCount + differ.diff.outCount + differ.diff.bothCount;
  return count === 0
    ? undefined
    : `  ${count} file(s) differ: ${differ.diff.inCount} in, ${differ.diff.outCount} out, ${differ.diff.bothCount} both.`;
}

/** Question 4's suggestion: 2 (keep mine) when a push would overwrite an `OUT`
 * or `BOTH` file, else 1. */
function existingSuggestion(differ: SetupDiffer, mode: SetupMode): number {
  return differ.hasSyncPoint &&
    differ.diff?.ok === true &&
    (differ.diff.outCount > 0 || differ.diff.bothCount > 0) &&
    mode === "push"
    ? 2
    : 1;
}

/** The guard for answer 4, when one applies: `backup` with a sync point and
 * either a failed diff or a diff that printed an `OUT` or `BOTH` line. */
type SetupGuard =
  | {
      readonly kind: "blocked";
      readonly lines: readonly string[];
      readonly count: number;
    }
  | { readonly kind: "failed" };

function guardOf(
  differ: SetupDiffer,
  action: ExistingAction,
): SetupGuard | undefined {
  if (
    action !== "backup" ||
    !differ.hasSyncPoint ||
    differ.diff === undefined
  ) {
    return undefined;
  }
  if (!differ.diff.ok) {
    return { kind: "failed" };
  }
  return differ.diff.blocked.length === 0
    ? undefined
    : {
        kind: "blocked",
        lines: differ.diff.blocked,
        count: differ.diff.blocked.length,
      };
}

/** Contract "Guard block": the blocked diff lines and the count line, or the
 * failed-diff line, each followed by a newline. */
function guardBlockText(guard: SetupGuard): string {
  if (guard.kind === "failed") {
    return "  Could not tell which side is newer; back up and replace may overwrite files changed here (each keeps a .bak).\n";
  }
  const countLine = `  ${guard.count} file(s) changed on this machine since the last sync; back up and replace overwrites them (each keeps a .bak).`;
  return `${[...guard.lines, countLine].join("\n")}\n`;
}

/** Contract "Confirm": `--yes` after a guard block stops with these lines.
 * A pull-only machine can't keep, so its lines don't suggest it. */
function guardRefusalText(guard: SetupGuard, mode: SetupMode): string {
  if (guard.kind === "failed") {
    return "ERROR: could not tell which side is newer; run mksync diff to see why, or run setup without --yes to confirm.";
  }
  const canKeep = mode === "push";
  const next = canKeep
    ? "Run mksync setup --existing keep to push them first, or run it without --yes to confirm."
    : "Run it without --yes to confirm.";
  return `ERROR: ${guard.count} file(s) changed on this machine since the last sync, and setup would overwrite them.\n${next}`;
}

/** The hostname up to its first dot: the name `setup` suggests, since macOS
 * reports `<name>.local` and a name holds no dot. */
function shortHostname(hostname: string): string {
  const dot = hostname.indexOf(".");
  return dot === -1 ? hostname : hostname.slice(0, dot);
}

function isName(value: string): boolean {
  return LAYER_NAME.test(value) && !RESERVED_LAYER_NAMES.includes(value);
}

function renderScan(scan: Scan): string {
  const found =
    scan.tools.found.length === 0 ? NONE : scan.tools.found.join(", ");
  const tools =
    scan.tools.missing.length === 0
      ? found
      : `${found} (not found: ${scan.tools.missing.join(", ")})`;
  return [
    "Scanning this machine...",
    `  OS         ${scan.os}`,
    `  Hostname   ${scan.hostname}`,
    `  Domain     ${scan.domain ?? NONE}`,
    `  Git email  ${scan.gitEmail ?? NONE}`,
    `  Tools      ${tools}`,
    `  Files      ${scan.files.existing} of ${scan.files.total} ${scan.os} entries already exist here`,
    "",
    "",
  ].join("\n");
}

/** The profiles the list offers: `personal`, then every non-retired store profile. */
function listedProfiles(profiles: readonly Profile[]): readonly string[] {
  const names = profiles
    .filter((profile) => !profile.retired && profile.name !== PERSONAL)
    .map((profile) => profile.name);
  return [PERSONAL, ...names];
}

function liveRecords(
  records: readonly MachineRecord[],
): readonly MachineRecord[] {
  return records.filter((record) => !record.retired);
}

/** Contract "Suggestions": the one live record with exactly this hostname, once private. */
function hostnameMatch(input: SetupInput): MachineRecord | undefined {
  if (!input.isPrivate) {
    return undefined;
  }
  const matches = liveRecords(input.records).filter(
    (record) => record.hostname === input.scan.hostname,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function renderProfiles(
  input: SetupInput,
  names: readonly string[],
  match: MachineRecord | undefined,
): string {
  const heading = input.isPrivate
    ? "Profiles in this repo:"
    : "Profiles on this machine:";
  const live = liveRecords(input.records);
  const lines = [heading];
  names.forEach((name, index) => {
    const machines = live
      .filter((record) => record.profile === name)
      .map((record) => record.name);
    // shortcut: the contract shows one machine per profile; several are joined
    // by ", " under "machines", pending the design's Open item.
    const owned =
      machines.length === 0
        ? ""
        : `${name.padEnd(NAME_COLUMN)}${machines.length === 1 ? "machine" : "machines"} ${machines.join(", ")}`;
    lines.push(`  ${index + 1}) ${owned === "" ? name : owned}`);
  });
  if (match !== undefined) {
    const choice = names.indexOf(match.profile) + 1;
    lines.push(
      `  This looks like ${match.name} (same hostname): choosing ${choice} replaces it.`,
    );
  }
  return `${lines.join("\n")}\n\n`;
}

/** A new profile's modules, in the config's module order. */
function newProfileModules(
  input: SetupInput,
  claude: ClaudeMode,
): readonly string[] {
  const found = new Set(input.scan.tools.found);
  const wanted = new Set(["shell", "git", ...OS_MODULES[input.scan.os]]);
  for (const [tool, module] of TOOL_MODULES) {
    if (found.has(tool)) {
      wanted.add(module);
    }
  }
  if (found.has("claude") && claude === "claude-deepseek") {
    wanted.add("claude-worker");
  }
  return Object.keys(input.config.modules).filter((module) =>
    wanted.has(module),
  );
}

/** Asks one question until it gets a usable answer, or returns `undefined` at
 * end of input when there is no suggestion. */
async function ask<T>(
  io: SetupIo,
  question: string,
  suggestion: number | undefined,
  read: (answer: string) => T | undefined,
  retry: string,
): Promise<T | undefined> {
  const prompt =
    suggestion === undefined ? `${question} ` : `${question} [${suggestion}] `;
  for (;;) {
    io.write(prompt);
    const line = await io.readLine();
    const answer = line === undefined ? "" : trimAnswer(line);
    if (answer === "") {
      return suggestion === undefined ? undefined : read(String(suggestion));
    }
    const value = read(answer);
    if (value !== undefined) {
      return value;
    }
    io.write(`${retry}\n`);
  }
}

function pick<T>(choices: readonly T[]): (answer: string) => T | undefined {
  return (answer) =>
    DIGITS.test(answer) ? choices[Number(answer) - 1] : undefined;
}

/** A question answered by its flag, by `--yes` with the suggestion, or by the user. */
async function answer<T>(
  io: SetupIo,
  flags: SetupFlags,
  flag: T | undefined,
  choices: readonly T[],
  question: string,
  suggestion: number,
): Promise<T> {
  if (flag !== undefined) {
    return flag;
  }
  const suggested = choices[suggestion - 1] as T;
  if (flags.yes === true) {
    return suggested;
  }
  const value = await ask(
    io,
    question,
    suggestion,
    pick(choices),
    `Pick 1 to ${choices.length}.`,
  );
  return value ?? suggested;
}

function profileNamed(input: SetupInput, name: string): Profile | undefined {
  return input.profiles.find(
    (profile) => profile.name === name && !profile.retired,
  );
}

/** The `dir` entry a linked folder's answer adds to a layer, under a folder
 * name that layer doesn't use yet: a second folder of the same name becomes
 * `<name>-2`, then `<name>-3`. */
function linkedEntry(
  entries: readonly ConfigV2Entry[],
  folder: LinkedFolder,
): ConfigV2Entry {
  const used = new Set(entries.map((entry) => entry.file));
  let name = folder.name;
  for (let index = 2; used.has(`${LINKED_FOLDER}${name}`); index += 1) {
    name = `${folder.name}-${index}`;
  }
  return {
    file: `${LINKED_FOLDER}${name}`,
    module: folder.module,
    merge: "dir",
    localPath: folder.path,
    description: `Linked folder ${folder.path}`,
  };
}

/** The linked-folder question's answer: the suggestion under `--yes`, else the
 * user's, ending at end of input on the suggestion. */
async function linkedAnswer(
  io: SetupIo,
  flags: SetupFlags,
  folder: LinkedFolder,
): Promise<number> {
  const suggestion = linkedSuggestionNumber(folder.suggestion);
  if (flags.yes === true) {
    return suggestion;
  }
  const value = await ask(
    io,
    linkedQuestion(folder.file, folder.path, folder.count, folder.bytes),
    suggestion,
    pick(LINKED_CHOICES),
    "Pick 1 to 3.",
  );
  return value ?? suggestion;
}

/**
 * The first-run flow of `mksync setup`, per the contract's "mksync setup": the
 * scan block, the profile list, the four questions, the bootstrap question,
 * the summary and the confirm. It returns the record and profile to write and
 * what to do with existing files; it writes nothing.
 */
export async function runSetup(
  input: SetupInput,
  io: SetupIo,
): Promise<SetupOutcome> {
  const { flags, scan } = input;
  if (flags.name !== undefined && flags.replace !== undefined) {
    return stop("ERROR: --name and --replace can't be used together.", 1);
  }
  if (input.own !== undefined && flags.replace === undefined) {
    return stop(
      `ERROR: this machine is already ${input.own.name}; use --replace to take over another record.`,
      1,
    );
  }
  let replacing: MachineRecord | undefined;
  if (flags.replace !== undefined) {
    replacing = liveRecords(input.records).find(
      (record) => record.name === flags.replace,
    );
    if (replacing === undefined) {
      return stop(
        `ERROR: no machine ${flags.replace} here; records are shared once the repo is private.`,
        1,
      );
    }
  }
  const name = flags.name ?? shortHostname(scan.hostname);
  if (replacing === undefined && !isName(name)) {
    return stop(
      `ERROR: ${name} isn't a valid machine name; use --name <machine>.`,
      2,
    );
  }
  if (flags.profile !== undefined && !isName(flags.profile)) {
    return stop(
      `ERROR: ${flags.profile} isn't a valid profile name; use --profile <name>.`,
      2,
    );
  }

  const names = listedProfiles(input.profiles);
  const match =
    replacing === undefined && flags.name === undefined
      ? hostnameMatch(input)
      : undefined;
  io.write(renderScan(scan));
  io.write(renderProfiles(input, names, match));

  let asked = false;
  let profileName = replacing?.profile ?? flags.profile;
  if (profileName === undefined) {
    const suggestion =
      match === undefined ? undefined : names.indexOf(match.profile) + 1;
    if (flags.yes === true && suggestion === undefined) {
      return stop("ERROR: missing --profile", 2);
    }
    if (flags.yes === true) {
      profileName = names[(suggestion as number) - 1];
    } else {
      asked = true;
      profileName = await ask(
        io,
        Q1,
        suggestion,
        (text) => {
          const chosen = pick(names)(text);
          if (chosen !== undefined) {
            return chosen;
          }
          // A number is always a choice, never a new profile's name.
          return isName(text) && !DIGITS.test(text) ? text : undefined;
        },
        `Pick 1 to ${names.length} or type a new profile name.`,
      );
    }
    if (profileName === undefined) {
      return stop("ERROR: missing --profile", 2);
    }
  }
  if (
    replacing === undefined &&
    input.profiles.some(
      (candidate) => candidate.name === profileName && candidate.retired,
    )
  ) {
    if (asked) {
      io.write("\n");
    }
    return stop(
      `ERROR: profile ${profileName} is retired; pick another name.`,
      1,
    );
  }
  if (
    replacing === undefined &&
    match !== undefined &&
    profileName === match.profile
  ) {
    replacing = match;
  }
  const machineName = replacing?.name ?? name;
  if (machineName === profileName) {
    if (asked) {
      io.write("\n");
    }
    return stop(
      `ERROR: machine ${machineName} can't share its profile's name; use --name <machine>.`,
      2,
    );
  }

  let claude = replacing?.claude;
  let mode: SetupMode | undefined =
    replacing === undefined
      ? undefined
      : replacing.pullOnly
        ? "pull-only"
        : "push";
  if (claude === undefined) {
    asked ||= flags.claude === undefined && flags.yes !== true;
    claude = await answer(
      io,
      flags,
      flags.claude,
      CLAUDE_CHOICES,
      Q2,
      scan.tools.found.includes("claude") ? 2 : 1,
    );
  }
  if (mode === undefined) {
    asked ||= flags.mode === undefined && flags.yes !== true;
    mode = await answer(io, flags, flags.mode, MODE_CHOICES, Q3, 1);
  }
  asked ||= flags.existing === undefined && flags.yes !== true;
  // Contract "What differs": one line above question 4, also when a flag
  // answers it; a count of 0 prints nothing.
  const shown = differLine(input.differ);
  if (shown !== undefined) {
    io.write(`${shown}\n`);
  }
  const action = await answer(
    io,
    flags,
    flags.existing,
    EXISTING_CHOICES,
    Q4,
    existingSuggestion(input.differ, mode),
  );
  if (asked) {
    io.write("\n");
  }
  if (mode === "pull-only" && action === "keep") {
    return stop(
      "ERROR: --existing keep pushes first, so it can't be used with --mode pull-only.",
      1,
    );
  }

  // Contract "Bootstrap": asked after question 4 and before the summary, never
  // for the `stop` answer; `--bootstrap` chooses it without asking.
  let bootstrap =
    input.bootstrapOffered === true &&
    flags.bootstrap === true &&
    action !== "stop";
  if (
    input.bootstrapOffered === true &&
    flags.bootstrap !== true &&
    action !== "stop"
  ) {
    io.write(BOOTSTRAP_QUESTION);
    const answer = trimAnswer((await io.readLine()) ?? "");
    io.write("\n");
    bootstrap = isYes(answer);
  }

  const existing = profileNamed(input, profileName);
  const profile: Profile = existing ?? {
    name: profileName,
    modules: newProfileModules(input, claude),
    values: {},
    destinations: {},
    retired: false,
  };
  const record = buildRecord(input, replacing, name, profileName, claude, mode);

  const profileEntries = [...(profile.entries ?? [])];
  const recordEntries = [...(record.entries ?? [])];
  const destinations = { ...profile.destinations };
  const folders = input.linkedFolders?.(profile, record) ?? [];
  for (const folder of folders) {
    const choice = await linkedAnswer(io, flags, folder);
    if (choice === 1) {
      profileEntries.push(linkedEntry(profileEntries, folder));
    } else if (choice === 2) {
      recordEntries.push(linkedEntry(recordEntries, folder));
    } else {
      destinations[`${LINKED_DESTINATION_PREFIX}${folder.path}`] = "no";
    }
  }
  if (folders.length > 0 && flags.yes !== true) {
    io.write("\n");
  }
  const answeredProfile: Profile = {
    ...profile,
    destinations,
    ...(profile.entries !== undefined || profileEntries.length > 0
      ? { entries: profileEntries }
      : {}),
  };
  const answeredRecord: MachineRecord = {
    ...record,
    ...(record.entries !== undefined || recordEntries.length > 0
      ? { entries: recordEntries }
      : {}),
  };

  const nameFlag =
    replacing === undefined
      ? `--name ${record.name}`
      : `--replace ${record.name}`;
  const bootstrapFlag = bootstrap ? " --bootstrap" : "";
  io.write(
    `Machine ${record.name}: profile ${profileName}, ${CLAUDE_LABELS[claude]}, ${MODE_LABELS[mode]}.\n` +
      `Same as: mksync setup --profile ${profileName} ${nameFlag} --claude ${claude} --mode ${mode} --existing ${action}${bootstrapFlag}\n`,
  );
  // Contract "Guard block": after `Same as:`, the diff lines and the count when
  // answer 4 is `backup` with a sync point and an `OUT` or `BOTH` file (or a
  // failed diff). It turns the confirm's default into no.
  const guard = guardOf(input.differ, action);
  if (guard !== undefined) {
    io.write(guardBlockText(guard));
  }
  // Contract "Confirm": `--yes` answers yes without printing it, except after a
  // guard block, where it stops before anything is written. An empty answer is
  // yes for `[Y/n]` and no for `[y/N]`. End of input at `[Y/n]` is no too: with
  // no terminal (Claude Code's `!`, a closed pipe) nobody answered, so nothing
  // is written; the guarded `[y/N]` already read end of input as no.
  if (flags.yes === true) {
    if (guard !== undefined) {
      return stop(guardRefusalText(guard, mode), 1);
    }
  } else {
    const question =
      action === "stop" ? CONFIRM_STOP_QUESTION : CONFIRM_QUESTION;
    io.write(guard === undefined ? question : CONFIRM_GUARDED_QUESTION);
    const line = await io.readLine();
    if (guard === undefined && line === undefined) {
      return { ok: false, declined: true };
    }
    const answer = line === undefined ? "" : trimAnswer(line);
    if (guard === undefined ? isNo(answer) : !isYes(answer)) {
      return { ok: false, declined: true };
    }
  }
  return {
    ok: true,
    record: answeredRecord,
    profile: answeredProfile,
    newProfile: existing === undefined,
    action,
    replaced: replacing !== undefined,
    bootstrap,
  };
}

function buildRecord(
  input: SetupInput,
  replacing: MachineRecord | undefined,
  name: string,
  profile: string,
  claude: ClaudeMode,
  mode: SetupMode,
): MachineRecord {
  const { scan } = input;
  if (replacing === undefined) {
    return {
      name,
      profile,
      os: scan.os,
      hostname: scan.hostname,
      domain: scan.domain,
      claude,
      pullOnly: mode === "pull-only",
      modules: { add: [], remove: [] },
      values: {},
      replaced: [],
      retired: false,
    };
  }
  return replaceRecord(replacing, scan, input.today);
}
