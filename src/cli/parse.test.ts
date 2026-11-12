import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE as USAGE_TEXT } from "./parse.ts";

const EXPORT = { kind: "run", command: "export", force: false, preview: false, check: false, only: [] } as const;

const IMPORT = { kind: "run", command: "import", force: false, preview: false, check: false, only: [] } as const;

const USAGE = { kind: "usage" } as const;

const VERSION = { kind: "version" } as const;

function unknownOption(arg: string): { kind: "error"; message: string } {
  return { kind: "error", message: `Unknown option: ${arg}` };
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
    expect(parseArgs(["export", "--preview"])).toEqual({ ...EXPORT, preview: true });
  });

  test("should parse export --force", () => {
    expect(parseArgs(["export", "--force"])).toEqual({ ...EXPORT, force: true });
  });

  test("should parse import --check", () => {
    expect(parseArgs(["import", "--check"])).toEqual({ ...IMPORT, check: true });
  });

  test("should parse import --force", () => {
    expect(parseArgs(["import", "--force"])).toEqual({ ...IMPORT, force: true });
  });

  test("should collect one path per repeated --only", () => {
    expect(
      parseArgs(["export", "--only", "dotfiles/a", "--only", "dotfiles/b"]),
    ).toEqual({ ...EXPORT, only: ["dotfiles/a", "dotfiles/b"] });
  });

  test("should collect every path after one --only", () => {
    expect(parseArgs(["import", "--only", "/home/user/.gitconfig", "dotfiles/b"])).toEqual({
      ...IMPORT,
      only: ["/home/user/.gitconfig", "dotfiles/b"],
    });
  });

  test("should stop collecting --only paths at the next option", () => {
    expect(parseArgs(["export", "--only", "dotfiles/a", "--force"])).toEqual({
      ...EXPORT,
      force: true,
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
    expect(parseArgs(["import", "--preview"])).toEqual(unknownOption("--preview"));
  });

  test("should refuse a stray argument as an unknown option", () => {
    expect(parseArgs(["export", "dotfiles/a"])).toEqual(unknownOption("dotfiles/a"));
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

  test("should keep shadow out of the usage line", () => {
    expect(USAGE_TEXT.includes("shadow")).toBe(false);
  });
});
