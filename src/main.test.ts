import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { run, USAGE } from "./main.ts";

describe("mksync front", () => {
  test("--version prints the package version and exits 0", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: `mksync ${pkg.version}\n`, stderr: "" });
  });

  test("no command prints the usage line and exits 2", () => {
    expect(run([])).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
  });

  test("an unknown command prints the usage line and exits 2", () => {
    expect(run(["frobnicate"])).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
  });

  test("an unknown option prints Unknown option and exits 1", () => {
    expect(run(["--bogus"])).toEqual({ code: 1, stdout: "", stderr: "Unknown option: --bogus\n" });
  });
});
