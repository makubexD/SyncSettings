import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { removeOldProgram, run, USAGE } from "./main.ts";

const OLD_PROGRAM_NAME = "mksync.old.exe";

describe("mksync front", () => {
  test("--version prints the package version and exits 0", () => {
    expect(run(["--version"])).toEqual({
      code: 0,
      stdout: `mksync ${pkg.version}\n`,
      stderr: "",
    });
  });

  test("no command prints the usage line and exits 2", () => {
    expect(run([])).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
  });

  test("an unknown command prints the usage line and exits 2", () => {
    expect(run(["frobnicate"])).toEqual({
      code: 2,
      stdout: "",
      stderr: `${USAGE}\n`,
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
