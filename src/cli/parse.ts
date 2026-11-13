/**
 * The command line the program accepts (contract "The program", plan decision
 * 1): the old entry points' verbs and flags. Pure: argv in, a command or an
 * error out; nothing here touches the repo or the machine.
 */

import type { ClaudeMode } from "../core/machine/record.ts";
import type { ExistingAction, SetupFlags, SetupMode } from "../wizard/setup.ts";

export const USAGE =
  "usage: mksync export [--preview] [--only <path>...] | " +
  "mksync import [--check] [--force] [--only <path>...] | " +
  "mksync setup [--name <machine>] [--profile <name>] [--replace <machine>] " +
  "[--claude none|claude|claude-deepseek] [--mode push|pull-only] " +
  "[--existing backup|keep|stop] [--yes] | " +
  "mksync machine show | mksync machine retire <name> [--yes] | " +
  "mksync profile retire <name> [--yes] | mksync --version";

export type CommandName = "export" | "import";

/** A command the program runs against the repo. */
export interface RunCommand {
  readonly kind: "run";
  readonly command: CommandName;
  /** `--force`: overwrite without asking (an import never skips the `.bak`). */
  readonly force: boolean;
  /** `export --preview`: what a commit would send. */
  readonly preview: boolean;
  /** `import --check`: what an import would change. */
  readonly check: boolean;
  readonly only: readonly string[];
}

/**
 * `shadow`: compare the program and the old engine next to the clone. Hidden:
 * it is not in `USAGE` (the design's "Open" keeps the name under review).
 */
export interface ShadowCommand {
  readonly kind: "shadow";
}

/** `machine show`: print the machine record, exit 0. */
export interface MachineShowCommand {
  readonly kind: "machine-show";
}

/** `machine retire <name>`: the record to retire and whether `--yes` answers
 * the question. */
export interface MachineRetireCommand {
  readonly kind: "machine-retire";
  readonly target: string;
  readonly yes: boolean;
}

/** `profile retire <name>`: the profile to retire and whether `--yes` answers
 * the question. */
export interface ProfileRetireCommand {
  readonly kind: "profile-retire";
  readonly target: string;
  readonly yes: boolean;
}

/** Either retire command. */
export type RetireCommand = MachineRetireCommand | ProfileRetireCommand;

/** `setup`: the first-run flow's flags, parsed but not validated. */
export interface SetupCommand extends SetupFlags {
  readonly kind: "setup";
}

/** `--version`: print the program's version, exit 0. */
export interface VersionCommand {
  readonly kind: "version";
}

/** No command, or one that isn't a verb: print the usage line, exit 2. */
export interface UsageCommand {
  readonly kind: "usage";
}

/** An unknown option or a bad `--only`: print the message on stderr, exit 1. */
export interface ParseError {
  readonly kind: "error";
  readonly message: string;
}

export type ParsedCommand =
  | RunCommand
  | ShadowCommand
  | MachineShowCommand
  | MachineRetireCommand
  | ProfileRetireCommand
  | SetupCommand
  | VersionCommand
  | UsageCommand
  | ParseError;

const VERSION_OPTION = "--version";

const SHADOW_COMMAND = "shadow";

const MACHINE_COMMAND = "machine";

const MACHINE_SHOW_VERB = "show";

const PROFILE_COMMAND = "profile";

/** The verb both retire commands share. */
const RETIRE_VERB = "retire";

const SETUP_COMMAND = "setup";

const SETUP_YES = "--yes";

const ONLY_OPTION = "--only";

const ONLY_NEEDS_PATH = "ERROR: --only needs a path.";

const UNKNOWN_OPTION_PREFIX = "Unknown option: ";

/** The setup flags that take a value after them (decision 5). */
const SETUP_VALUE_FLAGS = [
  "--name",
  "--profile",
  "--replace",
  "--claude",
  "--mode",
  "--existing",
] as const;

type SetupValueFlag = (typeof SETUP_VALUE_FLAGS)[number];

const SETUP_CLAUDE_CHOICES: readonly ClaudeMode[] = [
  "none",
  "claude",
  "claude-deepseek",
];

const SETUP_MODE_CHOICES: readonly SetupMode[] = ["push", "pull-only"];

const SETUP_EXISTING_CHOICES: readonly ExistingAction[] = [
  "backup",
  "keep",
  "stop",
];

/** The options each verb accepts besides `--only`, which takes a value. */
const FLAGS: Readonly<Record<CommandName, readonly string[]>> = {
  export: ["--preview"],
  import: ["--check", "--force"],
};

function isCommandName(value: string): value is CommandName {
  return value === "export" || value === "import";
}

function error(message: string): ParseError {
  return { kind: "error", message };
}

function isOption(arg: string): boolean {
  return arg.startsWith("-");
}

/**
 * Read the paths that follow `--only`. The entry points take one path per
 * `--only`; the contract's `[--only <path>…]` also spells several after one,
 * so every argument up to the next option is a path.
 */
function takeOnlyPaths(
  argv: readonly string[],
  start: number,
): { readonly paths: readonly string[]; readonly next: number } {
  const paths: string[] = [];
  let index = start;
  for (;;) {
    const value = argv[index];
    if (value === undefined || isOption(value)) {
      return { paths, next: index };
    }
    paths.push(value);
    index++;
  }
}

function isSetupValueFlag(value: string): value is SetupValueFlag {
  return (SETUP_VALUE_FLAGS as readonly string[]).includes(value);
}

function isChoice<T extends string>(
  choices: readonly T[],
  value: string,
): value is T {
  return choices.some((choice) => choice === value);
}

function setupError(message: string): ParseError {
  return error(`ERROR: ${message}`);
}

/** A setup flag given twice. */
function repeatedFlag(flag: string): ParseError {
  return setupError(`${flag} is repeated.`);
}

function flagNeedsValue(flag: string): ParseError {
  return setupError(`${flag} needs a value.`);
}

function notAChoice(flag: string, choices: readonly string[]): ParseError {
  return setupError(`${flag} must be one of ${choices.join(", ")}.`);
}

/** The retire commands' missing target, in the `needs a …` form. */
function retireNeedsName(noun: string): ParseError {
  return setupError(`${noun} retire needs a name.`);
}

/**
 * `machine retire <name> [--yes]` and `profile retire <name> [--yes]`
 * (decision 5): one target, with `--yes` either side of it. The store lookup
 * and the question belong to the caller.
 */
function parseRetire(
  argv: readonly string[],
  kind: "machine-retire" | "profile-retire",
): RetireCommand | ParseError {
  const noun = kind === "machine-retire" ? "machine" : "profile";
  let target: string | undefined;
  let yes = false;

  let index = 2;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === SETUP_YES) {
      if (yes) {
        return repeatedFlag(arg);
      }
      yes = true;
      index++;
      continue;
    }
    if (isOption(arg) || target !== undefined) {
      return error(`${UNKNOWN_OPTION_PREFIX}${arg}`);
    }
    target = arg;
    index++;
  }

  return target === undefined ? retireNeedsName(noun) : { kind, target, yes };
}

/**
 * Parse the flags after `setup` (decision 5). The flow validates names, not
 * this parser; here a flag only has to take its value and be given once.
 */
function parseSetup(argv: readonly string[]): SetupCommand | ParseError {
  let name: string | undefined;
  let profile: string | undefined;
  let replace: string | undefined;
  let claude: ClaudeMode | undefined;
  let mode: SetupMode | undefined;
  let existing: ExistingAction | undefined;
  let yes = false;

  let index = 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === SETUP_YES) {
      if (yes) {
        return repeatedFlag(arg);
      }
      yes = true;
      index++;
      continue;
    }
    if (!isSetupValueFlag(arg)) {
      return error(`${UNKNOWN_OPTION_PREFIX}${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || isOption(value)) {
      return flagNeedsValue(arg);
    }
    switch (arg) {
      case "--name":
        if (name !== undefined) {
          return repeatedFlag(arg);
        }
        name = value;
        break;
      case "--profile":
        if (profile !== undefined) {
          return repeatedFlag(arg);
        }
        profile = value;
        break;
      case "--replace":
        if (replace !== undefined) {
          return repeatedFlag(arg);
        }
        replace = value;
        break;
      case "--claude":
        if (claude !== undefined) {
          return repeatedFlag(arg);
        }
        if (!isChoice(SETUP_CLAUDE_CHOICES, value)) {
          return notAChoice(arg, SETUP_CLAUDE_CHOICES);
        }
        claude = value;
        break;
      case "--mode":
        if (mode !== undefined) {
          return repeatedFlag(arg);
        }
        if (!isChoice(SETUP_MODE_CHOICES, value)) {
          return notAChoice(arg, SETUP_MODE_CHOICES);
        }
        mode = value;
        break;
      case "--existing":
        if (existing !== undefined) {
          return repeatedFlag(arg);
        }
        if (!isChoice(SETUP_EXISTING_CHOICES, value)) {
          return notAChoice(arg, SETUP_EXISTING_CHOICES);
        }
        existing = value;
        break;
    }
    index += 2;
  }

  return {
    kind: "setup",
    ...(name === undefined ? {} : { name }),
    ...(profile === undefined ? {} : { profile }),
    ...(replace === undefined ? {} : { replace }),
    ...(claude === undefined ? {} : { claude }),
    ...(mode === undefined ? {} : { mode }),
    ...(existing === undefined ? {} : { existing }),
    ...(yes ? { yes: true } : {}),
  };
}

/**
 * Parse argv into the program's command, the usage line, the version or an
 * option error. An argument that starts with `-` and isn't a valid flag for
 * the verb is `Unknown option: <arg>`, as the entry points print it; a stray
 * positional argument gets the same message, as the bash entry points do.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command === undefined) {
    return { kind: "usage" };
  }
  if (command === VERSION_OPTION) {
    return { kind: "version" };
  }
  if (command === SHADOW_COMMAND) {
    const extra = argv[1];
    return extra === undefined
      ? { kind: "shadow" }
      : error(`${UNKNOWN_OPTION_PREFIX}${extra}`);
  }
  if (command === MACHINE_COMMAND) {
    const verb = argv[1];
    if (verb === undefined) {
      return { kind: "usage" };
    }
    if (verb === RETIRE_VERB) {
      return parseRetire(argv, "machine-retire");
    }
    if (verb !== MACHINE_SHOW_VERB) {
      return error(`${UNKNOWN_OPTION_PREFIX}${verb}`);
    }
    const extra = argv[2];
    return extra === undefined
      ? { kind: "machine-show" }
      : error(`${UNKNOWN_OPTION_PREFIX}${extra}`);
  }
  if (command === PROFILE_COMMAND) {
    const verb = argv[1];
    if (verb === undefined) {
      return { kind: "usage" };
    }
    if (verb !== RETIRE_VERB) {
      return error(`${UNKNOWN_OPTION_PREFIX}${verb}`);
    }
    return parseRetire(argv, "profile-retire");
  }
  if (command === SETUP_COMMAND) {
    return parseSetup(argv);
  }
  if (isOption(command) || !isCommandName(command)) {
    return isOption(command)
      ? error(`${UNKNOWN_OPTION_PREFIX}${command}`)
      : { kind: "usage" };
  }

  const flags = FLAGS[command];
  const only: string[] = [];
  let force = false;
  let preview = false;
  let check = false;

  let index = 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === ONLY_OPTION) {
      const taken = takeOnlyPaths(argv, index + 1);
      if (taken.paths.length === 0) {
        return error(ONLY_NEEDS_PATH);
      }
      only.push(...taken.paths);
      index = taken.next;
      continue;
    }
    if (!flags.includes(arg)) {
      return error(`${UNKNOWN_OPTION_PREFIX}${arg}`);
    }
    switch (arg) {
      case "--force":
        force = true;
        break;
      case "--preview":
        preview = true;
        break;
      case "--check":
        check = true;
        break;
      default:
        return error(`${UNKNOWN_OPTION_PREFIX}${arg}`);
    }
    index++;
  }

  return { kind: "run", command, force, preview, check, only };
}
