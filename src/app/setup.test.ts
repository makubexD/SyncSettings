import { describe, expect, test } from "bun:test";
import { bootstrapEnv } from "./setup.ts";

describe("bootstrapEnv", () => {
  test("the installed program is passed on as MKSYNC_PROGRAM", () => {
    const env = bootstrapEnv({ HOME: "/h" }, "/h/.local/bin/mksync");
    expect(env).toEqual({ HOME: "/h", MKSYNC_PROGRAM: "/h/.local/bin/mksync" });
  });

  test("under the clone's launcher the environment is left alone", () => {
    const env = bootstrapEnv({ HOME: "/h", MKSYNC_LAUNCHER: "1" }, "/h/.local/bin/mksync");
    expect(env).toEqual({ HOME: "/h", MKSYNC_LAUNCHER: "1" });
  });

  test("a runtime that is not the program is not passed on", () => {
    const env = bootstrapEnv({ HOME: "/h" }, "/usr/local/bin/bun");
    expect(env).toEqual({ HOME: "/h" });
  });
});
