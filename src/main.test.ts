import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { HELP_TEXT } from "./cli/help.ts";
import { removeOldProgram, run } from "./main.ts";

const OLD_PROGRAM_NAME = "mksync.old.exe";

describe("mksync front", () => {
  test("--version prints the package version and exits 0", () => {
    expect(run(["--version"])).toEqual({
      code: 0,
      stdout: `mksync ${pkg.version}\n`,
      stderr: "",
    });
  });

  test("no command returns the status command", () => {
    expect(run([])).toEqual({ kind: "status" });
  });

  test("--help prints the top-level help on stdout and exits 0", () => {
    expect(run(["--help"])).toEqual({
      code: 0,
      stdout: HELP_TEXT.top,
      stderr: "",
    });
  });

  test("setting move --help prints the verb's help and exits 0", () => {
    expect(run(["setting", "move", "--help"])).toEqual({
      code: 0,
      stdout: HELP_TEXT["setting move"],
      stderr: "",
    });
  });

  test("push --yes --help returns help, not a push to execute", () => {
    expect(run(["push", "--yes", "--help"])).toEqual({
      code: 0,
      stdout: HELP_TEXT.push,
      stderr: "",
    });
  });

  test("an unknown command names it and exits 2", () => {
    expect(run(["frobnicate"])).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "ERROR: unknown command frobnicate\nRun mksync --help for the list of commands.\n",
    });
  });

  test("an unknown option prints Unknown option and exits 2", () => {
    expect(run(["--bogus"])).toEqual({
      code: 2,
      stdout: "",
      stderr: "Unknown option: --bogus\n",
    });
  });
});

describe("removeOldProgram", () => {
  test("should delete the leftover program on win32 and leave it on linux", () => {
    const dir = mkdtempSync(join(tmpdir(), "mksync-old-"));
    const execPath = join(dir, "mksync.exe");
    const oldPath = join(dir, OLD_PROGRAM_NAME);

    try {
      writeFileSync(oldPath, "old");
      removeOldProgram("win32", execPath);
      expect(existsSync(oldPath)).toBe(false);

      writeFileSync(oldPath, "old");
      removeOldProgram("linux", execPath);
      expect(existsSync(oldPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
