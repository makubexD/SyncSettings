import type { Scan } from "../adapters/scan.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { LAYER_NAME, RESERVED_LAYER_NAMES } from "../core/layers/names.ts";
import type { ClaudeMode, MachineRecord } from "../core/machine/record.ts";

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
    }
  | { readonly ok: false; readonly message: string; readonly code: 1 | 2 };

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

const OS_MODULES: Readonly<Record<Os, readonly string[]>> = {
  linux: ["gnome"],
  windows: ["windows-terminal"],
  macos: [],
};

function stop(message: string, code: 1 | 2): SetupOutcome {
  return { ok: false, message, code };
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
    const answer = line?.trim() ?? "";
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
  return (answer) => {
    const index = Number(answer);
    return Number.isInteger(index) ? choices[index - 1] : undefined;
  };
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

/**
 * The first-run flow of `mksync setup`, per the contract's "mksync setup": the
 * scan block, the profile list, the four questions and the summary. It returns
 * the record and profile to write and what to do with existing files; it
 * writes nothing.
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
  const name = flags.name ?? scan.hostname;
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
    match !== undefined &&
    profileName === match.profile
  ) {
    replacing = match;
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
  const action = await answer(
    io,
    flags,
    flags.existing,
    EXISTING_CHOICES,
    Q4,
    1,
  );
  if (asked) {
    io.write("\n");
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

  const nameFlag =
    replacing === undefined
      ? `--name ${record.name}`
      : `--replace ${record.name}`;
  io.write(
    `Machine ${record.name}: profile ${profileName}, ${CLAUDE_LABELS[claude]}, ${MODE_LABELS[mode]}.\n` +
      `Same as: mksync setup --profile ${profileName} ${nameFlag} --claude ${claude} --mode ${mode} --existing ${action}\n`,
  );
  return {
    ok: true,
    record,
    profile,
    newProfile: existing === undefined,
    action,
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
  const moved =
    replacing.hostname !== scan.hostname || replacing.domain !== scan.domain;
  // shortcut: a takeover on the same hostname and domain adds no history
  // entry; the contract doesn't say, pending the design's Open item.
  const replaced = moved
    ? [
        ...replacing.replaced,
        {
          hostname: replacing.hostname,
          domain: replacing.domain,
          date: input.today,
        },
      ]
    : replacing.replaced;
  return {
    ...replacing,
    os: scan.os,
    hostname: scan.hostname,
    domain: scan.domain,
    replaced,
  };
}
