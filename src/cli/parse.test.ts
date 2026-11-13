import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE as USAGE_TEXT } from "./parse.ts";

const EXPORT = {
  kind: "run",
  command: "export",
  force: false,
  preview: false,
  check: false,
  only: [],
} as const;

const IMPORT = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: false,
  only: [],
} as const;

const USAGE = { kind: "usage" } as const;

const VERSION = { kind: "version" } as const;

const MACHINE_SHOW = { kind: "machine-show" } as const;

const SETUP = { kind: "setup" } as const;

function unknownOption(arg: string): { kind: "error"; message: string } {
  return { kind: "error", message: `Unknown option: ${arg}` };
}

function usageError(message: string): { kind: "error"; message: string } {
  return { kind: "error", message };
}

describe("parseArgs", () => {
  test("should ask for the usage line when given no argument", () => {
    expect(parseArgs([])).toEqual(USAGE);
  });

  test("should ask for the usage line when the verb is unknown", () => {
    expect(parseArgs(["frobnicate"])).toEqual(USAGE);
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
    expect(parseArgs(["import", "--only"])).toEqual({
      kind: "error",
      message: "ERROR: --only needs a path.",
    });
  });

  test("should refuse --only followed by another option", () => {
    expect(parseArgs(["import", "--only", "--force"])).toEqual({
      kind: "error",
      message: "ERROR: --only needs a path.",
    });
  });

  test("should parse machine show", () => {
    expect(parseArgs(["machine", "show"])).toEqual(MACHINE_SHOW);
  });

  test("should ask for the usage line when machine has no verb", () => {
    expect(parseArgs(["machine"])).toEqual(USAGE);
  });

  test("should refuse a machine noun that isn't show", () => {
    expect(parseArgs(["machine", "retire"])).toEqual(unknownOption("retire"));
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
      yes: true,
    });
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

  test("should keep shadow out of the usage line", () => {
    expect(USAGE_TEXT.includes("shadow")).toBe(false);
  });

  test("should name machine show in the usage line", () => {
    expect(USAGE_TEXT.includes("mksync machine show")).toBe(true);
  });

  test("should name setup in the usage line", () => {
    expect(USAGE_TEXT.includes("mksync setup")).toBe(true);
  });
});
