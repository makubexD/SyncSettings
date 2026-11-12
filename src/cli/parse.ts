/**
 * The command line the program accepts (contract "The program", plan decision
 * 1): the old entry points' verbs and flags. Pure: argv in, a command or an
 * error out; nothing here touches the repo or the machine.
 */

export const USAGE =
  "usage: mksync export [--preview] [--force] [--only <path>...] | " +
  "mksync import [--check] [--force] [--only <path>...] | mksync --version";

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
  | VersionCommand
  | UsageCommand
  | ParseError;

const VERSION_OPTION = "--version";

const SHADOW_COMMAND = "shadow";

const ONLY_OPTION = "--only";

const ONLY_NEEDS_PATH = "ERROR: --only needs a path.";

const UNKNOWN_OPTION_PREFIX = "Unknown option: ";

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
