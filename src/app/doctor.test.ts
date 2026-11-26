import { describe, expect, test } from "bun:test";
import type { ConfigV2, ConfigV2Entry } from "../core/config/types.ts";
import { doctorGitFacts } from "./doctor.ts";
import type { RawGitFacts } from "./doctor.ts";

const LOCAL_PATH = "~/.gitconfig.local";

const GH_PLACEHOLDER = "<GH_CLI_PATH>";

const DEFAULT_GH = "C:\\Program Files\\GitHub CLI\\gh.exe";

const SAVED_GH = "D:\\Tools\\gh\\gh.exe";

const FOUND_GH = "C:\\Users\\u\\AppData\\Local\\gh\\gh.exe";

const WORK_INCLUDE = "~/work/.gitconfig";

/** `.gitconfig.local` for `os`, with `sync-config.json`'s gh rule on Windows. */
function localEntry(os: "windows" | "linux"): ConfigV2Entry {
  return {
    file: "git/.gitconfig.local",
    module: "git",
    merge: "whole",
    localPath: LOCAL_PATH,
    os: [os],
    ...(os === "windows"
      ? {
          sanitize: [
            {
              placeholder: GH_PLACEHOLDER,
              prompt: "Path to GitHub CLI executable",
              default: DEFAULT_GH,
              escapeBackslashes: true,
            },
          ],
        }
      : {}),
  };
}

/** A config with a repo copy of `~/.gitconfig.local` for Windows and Linux. */
const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { git: { description: "Git" } },
  entries: [localEntry("windows"), localEntry("linux")],
};

/** The same config with no Linux copy. */
const WINDOWS_ONLY: ConfigV2 = { ...CONFIG, entries: [localEntry("windows")] };

/** A machine where git has nothing to report. */
const RAW: RawGitFacts = {
  xdgConfig: false,
  includes: [],
  localExists: true,
};

function raw(changes: Partial<RawGitFacts>): RawGitFacts {
  return { ...RAW, ...changes };
}

describe("doctorGitFacts", () => {
  test("should pass the XDG file and the includes through", () => {
    // Arrange
    const facts = raw({ xdgConfig: true, includes: [WORK_INCLUDE] });

    // Act
    const result = doctorGitFacts(CONFIG, "linux", facts, {});

    // Assert
    expect(result.xdgConfig).toBe(true);
    expect(result.includes).toEqual([WORK_INCLUDE]);
  });

  test("should report the local file missing when the OS has a repo copy", () => {
    const result = doctorGitFacts(
      CONFIG,
      "linux",
      raw({ localExists: false }),
      {},
    );

    expect(result.localMissing).toBe(true);
  });

  test("should not report the local file missing when it exists", () => {
    expect(doctorGitFacts(CONFIG, "linux", RAW, {}).localMissing).toBe(false);
  });

  test("should not report the local file missing without a repo copy for the OS", () => {
    const result = doctorGitFacts(
      WINDOWS_ONLY,
      "linux",
      raw({ localExists: false }),
      {},
    );

    expect(result.localMissing).toBe(false);
  });

  test("should take GH_CLI_PATH from the machine's values on windows", () => {
    const result = doctorGitFacts(
      CONFIG,
      "windows",
      raw({ ghPath: FOUND_GH }),
      { [GH_PLACEHOLDER]: SAVED_GH },
    );

    expect(result.ghPath).toBe(FOUND_GH);
    expect(result.ghCliValue).toBe(SAVED_GH);
  });

  test("should fall back to the rule's default without a saved value", () => {
    const result = doctorGitFacts(CONFIG, "windows", RAW, {});

    expect(result.ghCliValue).toBe(DEFAULT_GH);
  });

  test("should know no GH_CLI_PATH on linux, where no rule names it", () => {
    const result = doctorGitFacts(CONFIG, "linux", raw({ ghPath: FOUND_GH }), {
      [GH_PLACEHOLDER]: SAVED_GH,
    });

    expect(result.ghCliValue).toBeUndefined();
  });
});
