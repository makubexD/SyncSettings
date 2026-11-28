import { describe, expect, test } from "bun:test";
import type { HelpTopic } from "./help.ts";
import { parseArgs } from "./parse.ts";

const EXPORT = {
  kind: "run",
  command: "export",
  force: false,
  preview: false,
  check: false,
  resetValues: false,
  yes: false,
  only: [],
} as const;

const IMPORT = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: false,
  resetValues: false,
  yes: false,
  only: [],
} as const;

const VERSION = { kind: "version" } as const;

const MACHINE_SHOW = { kind: "machine-show" } as const;

const STATUS = { kind: "status" } as const;

const DOCTOR = { kind: "doctor" } as const;

const UPDATE = { kind: "update" } as const;

const DIFF = { kind: "diff", paths: [] } as const;

const CHECK = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: true,
  resetValues: false,
  yes: false,
  only: [],
} as const;

const PREVIEW = {
  kind: "run",
  command: "export",
  force: false,
  preview: true,
  check: false,
  resetValues: false,
  yes: false,
  only: [],
} as const;

const PULL = { kind: "pull", yes: false, force: false, paths: [] } as const;

const PUSH = { kind: "push", yes: false, force: false, paths: [] } as const;

const SETUP = { kind: "setup" } as const;

const COMMIT = { kind: "commit", partial: false, yes: false } as const;

function unknownOption(arg: string): {
  kind: "error";
  message: string;
  code: number;
} {
  return usageError(`Unknown option: ${arg}`);
}

/** Every usage error exits 2 (decision 7). */
function usageError(message: string): {
  kind: "error";
  message: string;
  code: number;
} {
  return { kind: "error", message, code: 2 };
}

/** Decision 4's two lines. */
function unknownCommand(word: string): ReturnType<typeof usageError> {
  return usageError(
    `ERROR: unknown command ${word}\nRun mksync --help for the list of commands.`,
  );
}

/** Decision 5's two lines: the group's error, then its hint. */
function groupError(
  line: string,
  group: string,
): ReturnType<typeof usageError> {
  return usageError(`${line}\nRun mksync ${group} --help for its commands.`);
}

function help(topic: HelpTopic): { kind: "help"; topic: HelpTopic } {
  return { kind: "help", topic };
}

describe("parseArgs help", () => {
  test.each([
    [["--help"], "top"],
    [["-h"], "top"],
    [["--version", "--help"], "top"],
    [["pull", "--help"], "pull"],
    [["pull", "--yes", "--force", "--help"], "pull"],
    [["pull", "dotfiles/x", "-h"], "pull"],
    [["push", "-m", "--help"], "push"],
    [["setup", "--name", "--help"], "setup"],
    [["setting", "--help"], "setting"],
    [["setting", "move", "a", "b", "--to", "base", "--help"], "setting move"],
    [["machine", "retire", "wk1", "--help"], "machine retire"],
    [["profile", "show", "--help"], "profile show"],
    [["export", "--help"], "export"],
    [["commit", "-m", "x", "--help"], "commit"],
  ] as const)("should print help for %j", (argv, topic) => {
    expect(parseArgs(argv)).toEqual(help(topic));
  });

  test("should still name an unknown command given --help", () => {
    expect(parseArgs(["bogus"])).toEqual(unknownCommand("bogus"));
    expect(parseArgs(["bogus", "--help"])).toEqual(unknownCommand("bogus"));
  });

  test("should still name an unknown group verb given --help", () => {
    expect(parseArgs(["machine", "list", "--help"])).toEqual(
      groupError("ERROR: unknown machine command list", "machine"),
    );
  });

  test("should keep an unknown first option as Unknown option", () => {
    expect(parseArgs(["-x"])).toEqual(unknownOption("-x"));
  });
});

describe("parseArgs", () => {
  test("should run the status when given no argument", () => {
    expect(parseArgs([])).toEqual(STATUS);
    expect(parseArgs([])).toEqual(parseArgs(["status"]));
  });

  test("should name an unknown command", () => {
    expect(parseArgs(["frobnicate"])).toEqual(unknownCommand("frobnicate"));
  });

  test("should print the version for --version", () => {
    expect(parseArgs(["--version"])).toEqual(VERSION);
  });

  test("should refuse an option where the verb belongs", () => {
    expect(parseArgs(["--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should parse a bare export", () => {
    expect(parseArgs(["export"])).toEqual(EXPORT);
  });

  test("should parse a bare import", () => {
    expect(parseArgs(["import"])).toEqual(IMPORT);
  });

  test("should parse export --preview", () => {
    expect(parseArgs(["export", "--preview"])).toEqual({
      ...EXPORT,
      preview: true,
    });
  });

  test("should reject export --force as bash does", () => {
    expect(parseArgs(["export", "--force"])).toEqual(unknownOption("--force"));
  });

  test("should parse export --yes", () => {
    expect(parseArgs(["export", "--yes"])).toEqual({
      ...EXPORT,
      yes: true,
    });
  });

  test("should refuse --yes given twice after export", () => {
    expect(parseArgs(["export", "--yes", "--yes"])).toEqual(
      usageError("ERROR: --yes is repeated."),
    );
  });

  test("should refuse export --preview --yes", () => {
    expect(parseArgs(["export", "--preview", "--yes"])).toEqual(
      usageError("ERROR: --preview and --yes can't be used together."),
    );
  });

  test("should refuse export --yes --preview", () => {
    expect(parseArgs(["export", "--yes", "--preview"])).toEqual(
      usageError("ERROR: --preview and --yes can't be used together."),
    );
  });

  test("should refuse export --diff --preview (diff_flags)", () => {
    expect(parseArgs(["export", "--diff", "--preview"])).toEqual(
      usageError("ERROR: --diff cannot be combined with --preview or --yes."),
    );
  });

  test("should refuse export --diff --yes (diff_flags)", () => {
    expect(parseArgs(["export", "--diff", "--yes"])).toEqual(
      usageError("ERROR: --diff cannot be combined with --preview or --yes."),
    );
  });

  test("should refuse export --preview --reset-values", () => {
    expect(parseArgs(["export", "--preview", "--reset-values"])).toEqual(
      unknownOption("--reset-values"),
    );
  });

  test("should refuse import --yes", () => {
    expect(parseArgs(["import", "--yes"])).toEqual(unknownOption("--yes"));
  });

  test("should parse import --check", () => {
    expect(parseArgs(["import", "--check"])).toEqual({
      ...IMPORT,
      check: true,
    });
  });

  test("should parse import --force", () => {
    expect(parseArgs(["import", "--force"])).toEqual({
      ...IMPORT,
      force: true,
    });
  });

  test("should parse import --reset-values", () => {
    expect(parseArgs(["import", "--reset-values"])).toEqual({
      ...IMPORT,
      resetValues: true,
    });
  });

  test("should refuse import --check --reset-values", () => {
    expect(parseArgs(["import", "--check", "--reset-values"])).toEqual(
      usageError("ERROR: --check cannot be combined with --reset-values."),
    );
  });

  test("should refuse import --reset-values --check", () => {
    expect(parseArgs(["import", "--reset-values", "--check"])).toEqual(
      usageError("ERROR: --check cannot be combined with --reset-values."),
    );
  });

  test("should collect one path per repeated --only", () => {
    expect(
      parseArgs(["export", "--only", "dotfiles/a", "--only", "dotfiles/b"]),
    ).toEqual({ ...EXPORT, only: ["dotfiles/a", "dotfiles/b"] });
  });

  test("should collect every path after one --only", () => {
    expect(
      parseArgs(["import", "--only", "/home/user/.gitconfig", "dotfiles/b"]),
    ).toEqual({
      ...IMPORT,
      only: ["/home/user/.gitconfig", "dotfiles/b"],
    });
  });

  test("should stop collecting --only paths at the next option", () => {
    expect(parseArgs(["export", "--only", "dotfiles/a", "--preview"])).toEqual({
      ...EXPORT,
      preview: true,
      only: ["dotfiles/a"],
    });
  });

  test("should parse a check with a picked path", () => {
    expect(parseArgs(["import", "--check", "--only", "dotfiles/a"])).toEqual({
      ...IMPORT,
      check: true,
      only: ["dotfiles/a"],
    });
  });

  test("should refuse an unknown option after export", () => {
    expect(parseArgs(["export", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should refuse an unknown option after import", () => {
    expect(parseArgs(["import", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should refuse import's flag on export", () => {
    expect(parseArgs(["export", "--check"])).toEqual(unknownOption("--check"));
  });

  test("should refuse export's flag on import", () => {
    expect(parseArgs(["import", "--preview"])).toEqual(
      unknownOption("--preview"),
    );
  });

  test("should refuse a stray argument as an unknown option", () => {
    expect(parseArgs(["export", "dotfiles/a"])).toEqual(
      unknownOption("dotfiles/a"),
    );
  });

  test("should refuse --only with no path", () => {
    expect(parseArgs(["import", "--only"])).toEqual(
      usageError("ERROR: --only needs a path."),
    );
  });

  test("should refuse --only followed by another option", () => {
    expect(parseArgs(["import", "--only", "--force"])).toEqual(
      usageError("ERROR: --only needs a path."),
    );
  });

  test("should parse status", () => {
    expect(parseArgs(["status"])).toEqual(STATUS);
  });

  test("should refuse an option after status", () => {
    expect(parseArgs(["status", "--force"])).toEqual(unknownOption("--force"));
  });

  test("should refuse a stray argument after status", () => {
    expect(parseArgs(["status", "extra"])).toEqual(unknownOption("extra"));
  });

  test("should parse doctor", () => {
    expect(parseArgs(["doctor"])).toEqual(DOCTOR);
  });

  test("should refuse an option after doctor", () => {
    expect(parseArgs(["doctor", "--force"])).toEqual(unknownOption("--force"));
  });

  test("should refuse a stray argument after doctor", () => {
    expect(parseArgs(["doctor", "extra"])).toEqual(unknownOption("extra"));
  });

  test("should parse update", () => {
    expect(parseArgs(["update"])).toEqual(UPDATE);
  });

  test("should refuse an option after update", () => {
    expect(parseArgs(["update", "--x"])).toEqual(unknownOption("--x"));
  });

  test("should refuse a stray argument after update", () => {
    expect(parseArgs(["update", "extra"])).toEqual(unknownOption("extra"));
  });

  test("should parse a bare diff", () => {
    expect(parseArgs(["diff"])).toEqual(DIFF);
  });

  test("should parse diff with picked paths", () => {
    expect(
      parseArgs([
        "diff",
        "dotfiles/common/parity/a.conf",
        "/home/user/.gitconfig",
      ]),
    ).toEqual({
      ...DIFF,
      paths: ["dotfiles/common/parity/a.conf", "/home/user/.gitconfig"],
    });
  });

  test("should refuse an option after diff", () => {
    expect(parseArgs(["diff", "--yes"])).toEqual(unknownOption("--yes"));
  });

  test("should parse a bare check", () => {
    expect(parseArgs(["check"])).toEqual(CHECK);
  });

  test("should parse check with picked paths", () => {
    expect(
      parseArgs(["check", "dotfiles/common/parity/a.conf", "b.conf"]),
    ).toEqual({
      ...CHECK,
      only: ["dotfiles/common/parity/a.conf", "b.conf"],
    });
  });

  test("should refuse an option after check", () => {
    expect(parseArgs(["check", "--only", "dotfiles/a"])).toEqual(
      unknownOption("--only"),
    );
  });

  test("should parse preview", () => {
    expect(parseArgs(["preview"])).toEqual(PREVIEW);
  });

  test("should refuse an option after preview", () => {
    expect(parseArgs(["preview", "--yes"])).toEqual(unknownOption("--yes"));
  });

  test("should refuse a stray argument after preview", () => {
    expect(parseArgs(["preview", "dotfiles/a"])).toEqual(
      unknownOption("dotfiles/a"),
    );
  });

  test("should parse pull", () => {
    expect(parseArgs(["pull"])).toEqual(PULL);
  });

  test("should parse pull --yes", () => {
    expect(parseArgs(["pull", "--yes"])).toEqual({ ...PULL, yes: true });
  });

  test("should parse pull --force", () => {
    expect(parseArgs(["pull", "--force"])).toEqual({ ...PULL, force: true });
  });

  test("should parse pull with one path", () => {
    expect(parseArgs(["pull", "dotfiles/common/parity/a.conf"])).toEqual({
      ...PULL,
      paths: ["dotfiles/common/parity/a.conf"],
    });
  });

  test("should parse pull with several paths and both flags", () => {
    expect(parseArgs(["pull", "--yes", "a.conf", "--force", "b.conf"])).toEqual(
      { ...PULL, yes: true, force: true, paths: ["a.conf", "b.conf"] },
    );
  });

  test("should refuse an unknown option after pull", () => {
    expect(parseArgs(["pull", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should refuse a short option after pull", () => {
    expect(parseArgs(["pull", "-x"])).toEqual(unknownOption("-x"));
  });

  test("should parse push", () => {
    expect(parseArgs(["push"])).toEqual(PUSH);
  });

  test("should parse push --yes", () => {
    expect(parseArgs(["push", "--yes"])).toEqual({ ...PUSH, yes: true });
  });

  test("should parse push --force", () => {
    expect(parseArgs(["push", "--force"])).toEqual({ ...PUSH, force: true });
  });

  test("should parse push with one path", () => {
    expect(parseArgs(["push", "dotfiles/common/parity/a.conf"])).toEqual({
      ...PUSH,
      paths: ["dotfiles/common/parity/a.conf"],
    });
  });

  test("should parse push with several paths and -m", () => {
    expect(
      parseArgs(["push", "--yes", "-m", "sync: work", "a.conf", "b.conf"]),
    ).toEqual({
      ...PUSH,
      yes: true,
      message: "sync: work",
      paths: ["a.conf", "b.conf"],
    });
  });

  test("should keep a push -m message that starts with a dash", () => {
    expect(parseArgs(["push", "-m", "--yes"])).toEqual({
      ...PUSH,
      message: "--yes",
    });
  });

  test("should keep the last push -m message", () => {
    expect(parseArgs(["push", "-m", "one", "-m", "two"])).toEqual({
      ...PUSH,
      message: "two",
    });
  });

  test("should refuse push -m with no value", () => {
    expect(parseArgs(["push", "-m"])).toEqual(
      usageError("Missing value for -m"),
    );
  });

  test("should refuse an unknown option after push", () => {
    expect(parseArgs(["push", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should parse machine show", () => {
    expect(parseArgs(["machine", "show"])).toEqual(MACHINE_SHOW);
  });

  test("should ask for show or retire when machine has no verb", () => {
    expect(parseArgs(["machine"])).toEqual(
      groupError("ERROR: machine needs show or retire", "machine"),
    );
  });

  test("should ask for a name when machine retire has none", () => {
    expect(parseArgs(["machine", "retire"])).toEqual(
      usageError("ERROR: machine retire needs a name."),
    );
  });

  test("should name a machine verb that isn't show or retire", () => {
    expect(parseArgs(["machine", "frobnicate"])).toEqual(
      groupError("ERROR: unknown machine command frobnicate", "machine"),
    );
  });

  test("should refuse an option in the machine verb's place", () => {
    expect(parseArgs(["machine", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should refuse an option after machine show", () => {
    expect(parseArgs(["machine", "show", "--force"])).toEqual(
      unknownOption("--force"),
    );
  });

  test("should refuse a stray argument after machine show", () => {
    expect(parseArgs(["machine", "show", "extra"])).toEqual(
      unknownOption("extra"),
    );
  });

  test("should parse machine retire with a name", () => {
    expect(parseArgs(["machine", "retire", "wk1-laptop"])).toEqual({
      kind: "machine-retire",
      target: "wk1-laptop",
      yes: false,
    });
  });

  test("should parse machine retire --yes after the name", () => {
    expect(parseArgs(["machine", "retire", "wk1-laptop", "--yes"])).toEqual({
      kind: "machine-retire",
      target: "wk1-laptop",
      yes: true,
    });
  });

  test("should parse machine retire --yes before the name", () => {
    expect(parseArgs(["machine", "retire", "--yes", "wk1-laptop"])).toEqual({
      kind: "machine-retire",
      target: "wk1-laptop",
      yes: true,
    });
  });

  test("should refuse --yes given twice after machine retire", () => {
    expect(
      parseArgs(["machine", "retire", "wk1-laptop", "--yes", "--yes"]),
    ).toEqual(usageError("ERROR: --yes is repeated."));
  });

  test("should refuse an unknown option after machine retire", () => {
    expect(parseArgs(["machine", "retire", "--force"])).toEqual(
      unknownOption("--force"),
    );
  });

  test("should refuse a stray argument after the machine retire name", () => {
    expect(parseArgs(["machine", "retire", "wk1-laptop", "extra"])).toEqual(
      unknownOption("extra"),
    );
  });

  test("should ask for show or retire when profile has no verb", () => {
    expect(parseArgs(["profile"])).toEqual(
      groupError("ERROR: profile needs show or retire", "profile"),
    );
  });

  test("should name a profile verb that isn't retire", () => {
    expect(parseArgs(["profile", "show"])).toEqual(
      groupError("ERROR: unknown profile command show", "profile"),
    );
    expect(parseArgs(["profile", "list"])).toEqual(
      groupError("ERROR: unknown profile command list", "profile"),
    );
  });

  test("should ask for a name when profile retire has none", () => {
    expect(parseArgs(["profile", "retire"])).toEqual(
      usageError("ERROR: profile retire needs a name."),
    );
  });

  test("should parse profile retire with a name", () => {
    expect(parseArgs(["profile", "retire", "work-1"])).toEqual({
      kind: "profile-retire",
      target: "work-1",
      yes: false,
    });
  });

  test("should parse profile retire --yes before the name", () => {
    expect(parseArgs(["profile", "retire", "--yes", "work-1"])).toEqual({
      kind: "profile-retire",
      target: "work-1",
      yes: true,
    });
  });

  test("should refuse an unknown option after profile retire", () => {
    expect(parseArgs(["profile", "retire", "work-1", "--force"])).toEqual(
      unknownOption("--force"),
    );
  });

  test("should parse setting list", () => {
    expect(parseArgs(["setting", "list"])).toEqual({ kind: "setting-list" });
  });

  test("should parse setting list --profile", () => {
    expect(parseArgs(["setting", "list", "--profile", "work1"])).toEqual({
      kind: "setting-list",
      profile: "work1",
    });
  });

  test("should refuse a stray argument after setting list", () => {
    expect(parseArgs(["setting", "list", "x"])).toEqual(unknownOption("x"));
  });

  test("should refuse setting list --profile with no value", () => {
    expect(parseArgs(["setting", "list", "--profile"])).toEqual(
      usageError("ERROR: --profile needs a value."),
    );
  });

  test("should refuse setting list --profile given twice", () => {
    expect(
      parseArgs(["setting", "list", "--profile", "a", "--profile", "b"]),
    ).toEqual(usageError("ERROR: --profile is repeated."));
  });

  test("should parse setting move with a key", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "editor.fontSize",
        "--to",
        "base",
      ]),
    ).toEqual({
      kind: "setting-move",
      file: "vscode/settings.json",
      key: "editor.fontSize",
      to: "base",
      dryRun: false,
      yes: false,
    });
  });

  test("should parse setting move --dry-run", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "editor.fontSize",
        "--to",
        "base",
        "--dry-run",
      ]),
    ).toEqual({
      kind: "setting-move",
      file: "vscode/settings.json",
      key: "editor.fontSize",
      to: "base",
      dryRun: true,
      yes: false,
    });
  });

  test("should parse setting move --yes before the positionals", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "--yes",
        "vscode/settings.json",
        "editor.fontSize",
        "--to",
        "base",
      ]),
    ).toEqual({
      kind: "setting-move",
      file: "vscode/settings.json",
      key: "editor.fontSize",
      to: "base",
      dryRun: false,
      yes: true,
    });
  });

  test("should parse setting move of a whole file with no key", () => {
    expect(
      parseArgs(["setting", "move", "git/.gitconfig.local", "--to", "os"]),
    ).toEqual({
      kind: "setting-move",
      file: "git/.gitconfig.local",
      to: "os",
      dryRun: false,
      yes: false,
    });
  });

  test("should ask for list or move when setting has no verb", () => {
    expect(parseArgs(["setting"])).toEqual(
      groupError("ERROR: setting needs list or move", "setting"),
    );
  });

  test("should name an unknown setting verb", () => {
    expect(parseArgs(["setting", "copy"])).toEqual(
      groupError("ERROR: unknown setting command copy", "setting"),
    );
  });

  test("should refuse an option in the setting verb's place", () => {
    expect(parseArgs(["setting", "--yes"])).toEqual(unknownOption("--yes"));
  });

  test("should ask for --to when setting move has none", () => {
    expect(
      parseArgs(["setting", "move", "vscode/settings.json", "editor.fontSize"]),
    ).toEqual(usageError("ERROR: missing --to"));
  });

  test("should refuse a --to that isn't a layer", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "a",
        "--to",
        "all",
      ]),
    ).toEqual(usageError("ERROR: --to takes base, os, profile or machine"));
  });

  test("should refuse --to with no value", () => {
    expect(
      parseArgs(["setting", "move", "vscode/settings.json", "a", "--to"]),
    ).toEqual(usageError("ERROR: --to needs a value."));
  });

  test("should refuse --to given twice", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "a",
        "--to",
        "base",
        "--to",
        "os",
      ]),
    ).toEqual(usageError("ERROR: --to is repeated."));
  });

  test("should refuse --dry-run with --yes", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "a",
        "--to",
        "base",
        "--dry-run",
        "--yes",
      ]),
    ).toEqual(usageError("ERROR: --dry-run and --yes can't be used together"));
  });

  test("should refuse a third positional after setting move", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "a",
        "b",
        "--to",
        "base",
      ]),
    ).toEqual(unknownOption("b"));
  });

  test("should refuse setting list --profile followed by an option", () => {
    expect(parseArgs(["setting", "list", "--profile", "--yes"])).toEqual(
      usageError("ERROR: --profile needs a value."),
    );
  });

  test("should refuse --to followed by an option", () => {
    expect(
      parseArgs([
        "setting",
        "move",
        "vscode/settings.json",
        "a",
        "--to",
        "--yes",
      ]),
    ).toEqual(usageError("ERROR: --to needs a value."));
  });

  test.each(["--dry-run", "--yes"])(
    "should refuse %s given twice after setting move",
    (flag) => {
      expect(
        parseArgs(["setting", "move", "f", "--to", "base", flag, flag]),
      ).toEqual(usageError(`ERROR: ${flag} is repeated.`));
    },
  );

  test("should refuse an unknown option after setting move", () => {
    expect(
      parseArgs(["setting", "move", "f", "--to", "base", "--force"]),
    ).toEqual(unknownOption("--force"));
  });

  test("should ask for a file when setting move has none", () => {
    expect(parseArgs(["setting", "move", "--to", "base"])).toEqual(
      usageError("ERROR: setting move needs a file"),
    );
  });

  test("should parse a bare setup", () => {
    expect(parseArgs(["setup"])).toEqual(SETUP);
  });

  test("should parse setup with every flag", () => {
    expect(
      parseArgs([
        "setup",
        "--name",
        "wk1-laptop",
        "--profile",
        "work-1",
        "--replace",
        "wk1-old",
        "--claude",
        "claude",
        "--mode",
        "pull-only",
        "--existing",
        "keep",
        "--bootstrap",
        "--yes",
      ]),
    ).toEqual({
      kind: "setup",
      name: "wk1-laptop",
      profile: "work-1",
      replace: "wk1-old",
      claude: "claude",
      mode: "pull-only",
      existing: "keep",
      bootstrap: true,
      yes: true,
    });
  });

  test("should parse setup --bootstrap", () => {
    expect(parseArgs(["setup", "--bootstrap"])).toEqual({
      kind: "setup",
      bootstrap: true,
    });
  });

  test("should refuse --bootstrap given twice", () => {
    expect(parseArgs(["setup", "--bootstrap", "--bootstrap"])).toEqual(
      usageError("ERROR: --bootstrap is repeated."),
    );
  });

  test("should parse setup --no-bootstrap", () => {
    expect(parseArgs(["setup", "--no-bootstrap"])).toEqual({
      kind: "setup",
      noBootstrap: true,
    });
  });

  test("should refuse --no-bootstrap given twice", () => {
    expect(parseArgs(["setup", "--no-bootstrap", "--no-bootstrap"])).toEqual(
      usageError("ERROR: --no-bootstrap is repeated."),
    );
  });

  test("should refuse --bootstrap with --no-bootstrap in either order", () => {
    const clash = usageError(
      "ERROR: --bootstrap and --no-bootstrap can't be used together",
    );
    expect(parseArgs(["setup", "--bootstrap", "--no-bootstrap"])).toEqual(
      clash,
    );
    expect(parseArgs(["setup", "--no-bootstrap", "--bootstrap"])).toEqual(
      clash,
    );
  });

  test("should accept every --claude value", () => {
    for (const claude of ["none", "claude", "claude-deepseek"] as const) {
      expect(parseArgs(["setup", "--claude", claude])).toEqual({
        kind: "setup",
        claude,
      });
    }
  });

  test("should accept every --mode value", () => {
    for (const mode of ["push", "pull-only"] as const) {
      expect(parseArgs(["setup", "--mode", mode])).toEqual({
        kind: "setup",
        mode,
      });
    }
  });

  test("should accept every --existing value", () => {
    for (const existing of ["backup", "keep", "stop"] as const) {
      expect(parseArgs(["setup", "--existing", existing])).toEqual({
        kind: "setup",
        existing,
      });
    }
  });

  test("should parse --label as a value flag", () => {
    expect(parseArgs(["setup", "--label", "Big Co"])).toEqual({
      kind: "setup",
      label: "Big Co",
    });
    expect(parseArgs(["setup", "--label"])).toEqual(
      usageError("ERROR: --label needs a value."),
    );
    expect(parseArgs(["setup", "--label", "a", "--label", "b"])).toEqual(
      usageError("ERROR: --label is repeated."),
    );
  });

  test("should refuse a 31-character, empty and slashed --label", () => {
    const refusal =
      "ERROR: --label: use 1 to 30 letters, digits, spaces or .-_&";
    for (const bad of ["x".repeat(31), "", "a/b"]) {
      expect(parseArgs(["setup", "--label", bad])).toEqual(usageError(refusal));
    }
  });

  test("should parse --value with or without the angle brackets", () => {
    // Act
    const bare = parseArgs(["setup", "--value", "YOUR_NAME=Jane"]);
    const bracketed = parseArgs(["setup", "--value", "<YOUR_NAME>=Jane"]);

    // Assert
    expect(bare).toEqual({
      kind: "setup",
      value: [{ placeholder: "<YOUR_NAME>", value: "Jane" }],
    });
    expect(bracketed).toEqual(bare);
  });

  test("should repeat --value in the order given, the later of one key winning", () => {
    // Act
    const parsed = parseArgs([
      "setup",
      "--value",
      "A=1",
      "--value",
      "B=2",
      "--value",
      "A=3",
    ]);

    // Assert
    expect(parsed).toEqual({
      kind: "setup",
      value: [
        { placeholder: "<A>", value: "3" },
        { placeholder: "<B>", value: "2" },
      ],
    });
  });

  test("should refuse an empty --value", () => {
    expect(parseArgs(["setup", "--value", "YOUR_NAME="])).toEqual(
      usageError("ERROR: --value <YOUR_NAME>: empty value"),
    );
  });

  test("should refuse a --value holding placeholder text", () => {
    expect(parseArgs(["setup", "--value", "YOUR_NAME=<HOME>"])).toEqual(
      usageError("ERROR: missing value for <YOUR_NAME>"),
    );
  });

  test("should refuse a --value holding a newline", () => {
    expect(parseArgs(["setup", "--value", "YOUR_NAME=a\nb"])).toEqual(
      usageError("ERROR: --value <YOUR_NAME>: value holds a control character"),
    );
  });

  test("should refuse a --value with no equals sign", () => {
    expect(parseArgs(["setup", "--value", "YOUR_NAME"])).toEqual(
      usageError("ERROR: --value needs KEY=VALUE."),
    );
  });

  test("should keep an equals sign inside a --value", () => {
    expect(parseArgs(["setup", "--value", "URL=a=b"])).toEqual({
      kind: "setup",
      value: [{ placeholder: "<URL>", value: "a=b" }],
    });
  });

  test("should parse --alias as a value flag", () => {
    expect(parseArgs(["setup", "--alias", "desk-a"])).toEqual({
      kind: "setup",
      alias: "desk-a",
    });
    expect(parseArgs(["setup", "--alias"])).toEqual(
      usageError("ERROR: --alias needs a value."),
    );
    expect(parseArgs(["setup", "--alias", "a-b", "--alias", "c-d"])).toEqual(
      usageError("ERROR: --alias is repeated."),
    );
  });

  test("should refuse a --claude value outside its list", () => {
    expect(parseArgs(["setup", "--claude", "opus"])).toEqual(
      usageError(
        "ERROR: --claude must be one of none, claude, claude-deepseek.",
      ),
    );
  });

  test("should refuse a --mode value outside its list", () => {
    expect(parseArgs(["setup", "--mode", "both"])).toEqual(
      usageError("ERROR: --mode must be one of push, pull-only."),
    );
  });

  test("should refuse an --existing value outside its list", () => {
    expect(parseArgs(["setup", "--existing", "merge"])).toEqual(
      usageError("ERROR: --existing must be one of backup, keep, stop."),
    );
  });

  test("should refuse a setup flag with no value", () => {
    expect(parseArgs(["setup", "--name"])).toEqual(
      usageError("ERROR: --name needs a value."),
    );
  });

  test("should refuse a setup flag followed by another flag", () => {
    expect(parseArgs(["setup", "--mode", "--yes"])).toEqual(
      usageError("ERROR: --mode needs a value."),
    );
  });

  test("should refuse a setup flag given twice", () => {
    expect(
      parseArgs(["setup", "--profile", "work-1", "--profile", "work-2"]),
    ).toEqual(usageError("ERROR: --profile is repeated."));
  });

  test("should refuse --yes given twice", () => {
    expect(parseArgs(["setup", "--yes", "--yes"])).toEqual(
      usageError("ERROR: --yes is repeated."),
    );
  });

  test("should refuse an unknown option after setup", () => {
    expect(parseArgs(["setup", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should refuse a stray argument after setup", () => {
    expect(parseArgs(["setup", "work-1"])).toEqual(unknownOption("work-1"));
  });

  test("should parse commit with no options", () => {
    expect(parseArgs(["commit"])).toEqual(COMMIT);
  });

  test("should parse commit -m and --partial", () => {
    expect(parseArgs(["commit", "-m", "sync: work", "--partial"])).toEqual({
      ...COMMIT,
      message: "sync: work",
      partial: true,
    });
  });

  test("should keep an -m message that starts with a dash", () => {
    expect(parseArgs(["commit", "-m", "--partial"])).toEqual({
      ...COMMIT,
      message: "--partial",
    });
  });

  test("should keep the last commit -m message", () => {
    expect(parseArgs(["commit", "-m", "one", "-m", "two"])).toEqual({
      ...COMMIT,
      message: "two",
    });
  });

  test("should refuse commit -m with no value", () => {
    expect(parseArgs(["commit", "-m"])).toEqual(
      usageError("ERROR: -m needs a value."),
    );
  });

  test("should refuse an unknown option after commit", () => {
    expect(parseArgs(["commit", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should refuse a stray argument after commit", () => {
    expect(parseArgs(["commit", "work-1"])).toEqual(unknownOption("work-1"));
  });

  test("should treat shadow as an unknown command", () => {
    expect(parseArgs(["shadow"])).toEqual(unknownCommand("shadow"));
  });
});

describe("usage errors exit 2", () => {
  test("should exit 2 on an unknown option", () => {
    expect(parseArgs(["export", "--bogus"])).toEqual(unknownOption("--bogus"));
  });

  test("should exit 2 when the preview verb is given --only", () => {
    expect(parseArgs(["preview", "--only", "dotfiles/a"])).toEqual(
      unknownOption("--only"),
    );
  });

  test("should exit 2 on clashing --preview --yes", () => {
    expect(parseArgs(["export", "--preview", "--yes"])).toEqual(
      usageError("ERROR: --preview and --yes can't be used together."),
    );
  });

  test("should exit 2 on a repeated --profile", () => {
    expect(
      parseArgs(["setup", "--profile", "work-1", "--profile", "personal"]),
    ).toEqual(usageError("ERROR: --profile is repeated."));
  });

  test("should exit 2 on an unknown verb in a group", () => {
    expect(parseArgs(["machine", "list"])).toEqual(
      groupError("ERROR: unknown machine command list", "machine"),
    );
  });
});
