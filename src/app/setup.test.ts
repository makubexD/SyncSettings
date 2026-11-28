import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCommand } from "../cli/parse.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import type { SetupValueAnswer, SetupValueChoice } from "../wizard/setup.ts";
import type { Result } from "./export.ts";
import {
  bootstrapEnv,
  bootstrapRefusal,
  exportKeep,
  placeAnswers,
  setupValues,
} from "./setup.ts";
import type { SetupValueSources } from "./setup.ts";

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

const PROFILE: Profile = {
  name: "work1",
  modules: ["parity"],
  values: {},
  destinations: {},
  retired: false,
};

const RECORD: MachineRecord = {
  name: "box1",
  profile: "work1",
  os: "linux",
  hostname: "box1",
  domain: null,
  claude: "none",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

/** A typed answer for `placeholder`, as the flow returns it. */
function typed(
  placeholder: string,
  value: string,
  kind: SetupValueAnswer["kind"] = "fill",
): SetupValueAnswer {
  return { kind, placeholder, value, source: "typed" };
}

describe("placeAnswers", () => {
  test("a machine value from the table goes to the record", () => {
    // Act
    const placed = placeAnswers(
      [typed("<HOME>", "/home/jane")],
      PROFILE,
      RECORD,
    );

    // Assert
    expect(placed.record.values).toEqual({ "<HOME>": "/home/jane" });
    expect(placed.profile.values).toEqual({});
  });

  test("a profile value from the table goes to the profile", () => {
    // Act
    const placed = placeAnswers(
      [typed("<YOUR_NAME>", "Jane")],
      PROFILE,
      RECORD,
    );

    // Assert
    expect(placed.profile.values).toEqual({ "<YOUR_NAME>": "Jane" });
    expect(placed.record.values).toEqual({});
  });

  test("a placeholder the table doesn't name goes to the profile", () => {
    // Act
    const placed = placeAnswers([typed("<OTHER>", "x")], PROFILE, RECORD);

    // Assert
    expect(placed.profile.values).toEqual({ "<OTHER>": "x" });
  });

  test("a replace answer stays on the record, over the old value", () => {
    // Arrange
    const old = { ...RECORD, values: { "<OTHER>": "old" } };

    // Act
    const placed = placeAnswers(
      [typed("<OTHER>", "new", "replace")],
      PROFILE,
      old,
    );

    // Assert
    expect(placed.record.values).toEqual({ "<OTHER>": "new" });
    expect(placed.profile.values).toEqual({});
  });
});

/** A repo whose one file holds `<YOUR_NAME>`, and an entry for `<YOUR_EMAIL>`
 * whose repo file is missing: the import asks only the first, keep's export
 * both. */
const VALUES_CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { parity: { description: "Parity fixture" } },
  entries: [
    {
      file: "parity/name.conf",
      module: "parity",
      merge: "whole",
      localPath: "~/.config/parity/name.conf",
      sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name" }],
    },
    {
      file: "parity/email.conf",
      module: "parity",
      merge: "whole",
      localPath: "~/.config/parity/email.conf",
      sanitize: [{ placeholder: "<YOUR_EMAIL>", prompt: "Email" }],
    },
  ],
};

const tempFolders: string[] = [];

afterEach(() => {
  for (const folder of tempFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** A throwaway repo, home and state folder, never the real ones. */
function valueSources(
  fileValues: Record<string, string> = {},
): SetupValueSources {
  const root = mkdtempSync(join(tmpdir(), "mksync-setup-values-"));
  tempFolders.push(root);
  const repoRoot = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repoRoot, "dotfiles", "linux", "parity"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoRoot, "dotfiles", "linux", "parity", "name.conf"),
    "name = <YOUR_NAME>\n",
  );
  return {
    repoRoot,
    state: join(root, "state"),
    home,
    os: "linux",
    config: VALUES_CONFIG,
    fileValues,
    differ: { updates: 0, hasSyncPoint: false },
    suggest: () => Promise.resolve({}),
  };
}

function choice(overrides: Partial<SetupValueChoice> = {}): SetupValueChoice {
  return {
    profile: PROFILE,
    record: RECORD,
    action: "backup",
    mode: "push",
    replaced: false,
    ...overrides,
  };
}

describe("setupValues", () => {
  test("backup asks the import's values", async () => {
    // Act
    const values = await setupValues(valueSources(), choice());

    // Assert
    expect(values.questions.map((question) => question.placeholder)).toEqual([
      "<YOUR_NAME>",
    ]);
  });

  test("keep adds the values keep's export would ask", async () => {
    // Act
    const values = await setupValues(
      valueSources(),
      choice({ action: "keep" }),
    );

    // Assert
    expect(values.questions.map((question) => question.placeholder)).toEqual([
      "<YOUR_NAME>",
      "<YOUR_EMAIL>",
    ]);
  });

  test("a value .user-values.json holds is not asked", async () => {
    // Act
    const values = await setupValues(
      valueSources({ "<YOUR_NAME>": "Jane" }),
      choice(),
    );

    // Assert
    expect(values.questions).toEqual([]);
  });

  test("a .user-values.json placeholder outside the table gets the kept-on question", async () => {
    // Act
    const values = await setupValues(
      valueSources({ "<OTHER>": "x" }),
      choice(),
    );

    // Assert
    expect(values.places).toEqual(["<OTHER>"]);
  });

  test("stop asks only the replace questions, the old value as the guess", async () => {
    // Arrange
    const old = { ...RECORD, values: { "<HOME>": "/home/old" } };

    // Act
    const values = await setupValues(
      valueSources(),
      choice({ action: "stop", record: old, replaced: true }),
    );

    // Assert
    expect(values.questions).toEqual([
      {
        kind: "replace",
        placeholder: "<HOME>",
        text: "  <HOME> [/home/old]: ",
        guess: { value: "/home/old", source: "old machine" },
      },
    ]);
  });
  describe("replace's fresh guess", () => {
    const OLD_PATH = "/old/bin/gh";
    const NEW_PATH = "/usr/bin/gh";
    const OLD_NAME = "Old Name";

    /** A config whose `<GH_CLI_PATH>` rule has a source and `<TOKEN>` an env var. */
    function guessConfig(): ConfigV2 {
      return {
        ...VALUES_CONFIG,
        entries: [
          {
            file: "parity/guess.conf",
            module: "parity",
            merge: "whole",
            localPath: "~/.config/parity/guess.conf",
            sanitize: [
              {
                placeholder: "<GH_CLI_PATH>",
                prompt: "Path to gh",
                suggest: ["gh-path"],
              },
              {
                placeholder: "<TOKEN_DIR>",
                prompt: "Token folder",
                defaultEnv: "PARITY_TOKEN_DIR",
              },
              { placeholder: "<YOUR_NAME>", prompt: "Full name" },
            ],
          },
        ],
      };
    }

    function oldMachine(): MachineRecord {
      return {
        ...RECORD,
        values: {
          "<GH_CLI_PATH>": OLD_PATH,
          "<TOKEN_DIR>": "/old/tokens",
          "<YOUR_NAME>": OLD_NAME,
        },
      };
    }

    function sources(env: Record<string, string>): SetupValueSources {
      return {
        ...valueSources(),
        config: guessConfig(),
        env,
        suggest: () =>
          Promise.resolve({
            "<GH_CLI_PATH>": { value: NEW_PATH, source: "gh-path" },
          }),
      };
    }

    test("should suggest this machine's guess over the old value", async () => {
      // Act
      const values = await setupValues(
        sources({}),
        choice({ action: "stop", record: oldMachine(), replaced: true }),
      );

      // Assert
      expect(values.questions[0]).toEqual({
        kind: "replace",
        placeholder: "<GH_CLI_PATH>",
        text: `  Path to gh (~/.config/parity/guess.conf) [${NEW_PATH}]: `,
        guess: { value: NEW_PATH, source: "gh-path" },
      });
    });

    test("should fall back to defaultEnv when no source answers", async () => {
      // Act
      const values = await setupValues(
        sources({ PARITY_TOKEN_DIR: "/new/tokens" }),
        choice({ action: "stop", record: oldMachine(), replaced: true }),
      );

      // Assert
      expect(values.questions[1]?.guess).toEqual({
        value: "/new/tokens",
        source: "defaultEnv",
      });
    });

    test("should keep the old value, source old machine, when nothing answers", async () => {
      // Act
      const values = await setupValues(
        sources({}),
        choice({ action: "stop", record: oldMachine(), replaced: true }),
      );

      // Assert
      expect(values.questions.map((question) => question.guess)).toEqual([
        { value: NEW_PATH, source: "gh-path" },
        { value: "/old/tokens", source: "old machine" },
        { value: OLD_NAME, source: "old machine" },
      ]);
    });

    test("should skip a defaultEnv guess holding a newline", async () => {
      // Act
      const values = await setupValues(
        sources({ PARITY_TOKEN_DIR: "/new\ntokens" }),
        choice({ action: "stop", record: oldMachine(), replaced: true }),
      );

      // Assert
      expect(values.questions[1]?.guess).toEqual({
        value: "/old/tokens",
        source: "old machine",
      });
    });
  });

  test("should list the .user-values.json placeholders setup copies in", async () => {
    // Act
    const values = await setupValues(
      valueSources({ "<YOUR_NAME>": "Jane" }),
      choice(),
    );

    // Assert
    expect(values.saved).toEqual(["<YOUR_NAME>"]);
  });
});
