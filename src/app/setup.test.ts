import { describe, expect, test } from "bun:test";
import type { RunCommand } from "../cli/parse.ts";
import type { Result } from "./export.ts";
import { bootstrapEnv, bootstrapRefusal, exportKeep } from "./setup.ts";

describe("bootstrapRefusal", () => {
  test("on Windows, --bootstrap is refused with the Ubuntu-only line", () => {
    const refusal = bootstrapRefusal("windows", {
      kind: "setup",
      bootstrap: true,
    });
    expect(refusal).toEqual({
      code: 1,
      stdout: "",
      stderr: "ERROR: --bootstrap is Ubuntu only.\n",
    });
  });

  test("on macOS, --bootstrap is refused with the Ubuntu-only line", () => {
    const refusal = bootstrapRefusal("macos", {
      kind: "setup",
      bootstrap: true,
    });
    expect(refusal).toEqual({
      code: 1,
      stdout: "",
      stderr: "ERROR: --bootstrap is Ubuntu only.\n",
    });
  });

  test("on Linux, --bootstrap is not refused", () => {
    const refusal = bootstrapRefusal("linux", {
      kind: "setup",
      bootstrap: true,
    });
    expect(refusal).toBeUndefined();
  });

  test("off Ubuntu, --no-bootstrap is accepted and does nothing", () => {
    for (const os of ["windows", "macos"] as const) {
      expect(
        bootstrapRefusal(os, { kind: "setup", noBootstrap: true }),
      ).toBeUndefined();
    }
  });
});

describe("bootstrapEnv", () => {
  test("the installed program is passed on as MKSYNC_PROGRAM", () => {
    const env = bootstrapEnv({ HOME: "/h" }, "/h/.local/bin/mksync");
    expect(env).toEqual({ HOME: "/h", MKSYNC_PROGRAM: "/h/.local/bin/mksync" });
  });

  test("under the clone's launcher the environment is left alone", () => {
    const env = bootstrapEnv(
      { HOME: "/h", MKSYNC_LAUNCHER: "1" },
      "/h/.local/bin/mksync",
    );
    expect(env).toEqual({ HOME: "/h", MKSYNC_LAUNCHER: "1" });
  });

  test("a runtime that is not the program is not passed on", () => {
    const env = bootstrapEnv({ HOME: "/h" }, "/usr/local/bin/bun");
    expect(env).toEqual({ HOME: "/h" });
  });
});

describe("exportKeep", () => {
  const OUT_LINE = "  OUT        dotfiles/common/shell/b.conf";

  function recorder(results: readonly Result[]): {
    readonly calls: (readonly string[])[];
    readonly execute: (command: RunCommand) => Promise<Result>;
  } {
    const calls: (readonly string[])[] = [];
    let next = 0;
    return {
      calls,
      execute: async (command) => {
        calls.push(command.kind === "run" ? command.only : []);
        const result = results[next] ?? { code: 0, stdout: "", stderr: "" };
        next += 1;
        return result;
      },
    };
  }

  const ok: Result = { code: 0, stdout: "", stderr: "" };

  test("with a diff, only the OUT and BOTH paths are exported", async () => {
    const r = recorder([ok]);
    await exportKeep(
      r.execute,
      {},
      {
        updates: 2,
        hasSyncPoint: true,
        diff: {
          ok: true,
          inCount: 1,
          outCount: 1,
          bothCount: 0,
          blocked: [OUT_LINE],
        },
      },
    );
    expect(r.calls).toEqual([["dotfiles/common/shell/b.conf"]]);
  });

  test("with only IN files, nothing is exported", async () => {
    const r = recorder([]);
    const result = await exportKeep(
      r.execute,
      {},
      {
        updates: 1,
        hasSyncPoint: true,
        diff: { ok: true, inCount: 1, outCount: 0, bothCount: 0, blocked: [] },
      },
    );
    expect(result).toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  test("without a sync point, the whole export runs", async () => {
    const r = recorder([ok]);
    await exportKeep(r.execute, {}, { updates: 1, hasSyncPoint: false });
    expect(r.calls).toEqual([[]]);
  });

  test("a path --only refuses falls back to the whole export", async () => {
    const refused: Result = {
      code: 1,
      stdout: "",
      stderr:
        "ERROR: dotfiles/common/shell/b.conf is not synced on this machine.\n",
    };
    const r = recorder([refused, ok]);
    const result = await exportKeep(
      r.execute,
      {},
      {
        updates: 1,
        hasSyncPoint: true,
        diff: {
          ok: true,
          inCount: 0,
          outCount: 1,
          bothCount: 0,
          blocked: [OUT_LINE],
        },
      },
    );
    expect(r.calls).toEqual([["dotfiles/common/shell/b.conf"], []]);
    expect(result?.code).toBe(0);
  });

  test("another export failure is returned as it is", async () => {
    const failed: Result = {
      code: 1,
      stdout: "",
      stderr: "ERROR: something else\n",
    };
    const r = recorder([failed]);
    const result = await exportKeep(
      r.execute,
      {},
      {
        updates: 1,
        hasSyncPoint: true,
        diff: {
          ok: true,
          inCount: 0,
          outCount: 1,
          bothCount: 0,
          blocked: [OUT_LINE],
        },
      },
    );
    expect(r.calls).toHaveLength(1);
    expect(result?.code).toBe(1);
  });
});
