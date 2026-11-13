import { describe, expect, test } from "bun:test";
import { groupBlock } from "./groups.ts";
import type { ChangeLine } from "./types.ts";

const RECORD = { name: "wk1-laptop", profile: "work-1" };

const BASE_LINE: ChangeLine = {
  layer: "base",
  kind: "M",
  module: "parity",
  file: "settings.json",
  what: "baseKey: 1 -> 2",
};

const OS_LINE: ChangeLine = {
  layer: "os",
  kind: "M",
  module: "parity",
  file: "settings.json",
  what: 'osKey: "linux" -> "linux-2"',
};

const PROFILE_LINE: ChangeLine = {
  layer: "profile",
  kind: "M",
  module: "parity",
  file: "settings.json",
  what: "profileKey: true -> false",
};

function baseLine(index: number): ChangeLine {
  return {
    layer: "base",
    kind: "M",
    module: "parity",
    file: "settings.json",
    what: `key${index}: 1 -> 2`,
  };
}

describe("groupBlock", () => {
  test("prints the four groups of a push with a record", () => {
    const block = groupBlock([BASE_LINE, OS_LINE, PROFILE_LINE], RECORD, "linux", "push");

    expect(block).toEqual([
      "Changes on wk1-laptop (profile work-1):",
      "",
      "All machines",
      "  1  M  parity  settings.json  baseKey: 1 -> 2",
      "Linux machines",
      '  2  M  parity  settings.json  osKey: "linux" -> "linux-2"',
      "Profile work-1",
      "  3  M  parity  settings.json  profileKey: true -> false",
      "This machine only",
      "     (none)",
      "",
    ]);
  });

  test("prints only the two shared groups without a record", () => {
    const block = groupBlock([BASE_LINE, OS_LINE], undefined, "linux", "push");

    expect(block).toEqual([
      "Changes on this machine:",
      "",
      "All machines",
      "  1  M  parity  settings.json  baseKey: 1 -> 2",
      "Linux machines",
      '  2  M  parity  settings.json  osKey: "linux" -> "linux-2"',
      "",
    ]);
  });

  test("uses the repo header for a pull", () => {
    const block = groupBlock([BASE_LINE], RECORD, "linux", "pull");

    expect(block[0]).toBe("Changes from the repo:");
  });

  test("prints (none) for an empty group", () => {
    const block = groupBlock([BASE_LINE, PROFILE_LINE], RECORD, "linux", "push");

    expect(block).toEqual([
      "Changes on wk1-laptop (profile work-1):",
      "",
      "All machines",
      "  1  M  parity  settings.json  baseKey: 1 -> 2",
      "Linux machines",
      "     (none)",
      "Profile work-1",
      "  2  M  parity  settings.json  profileKey: true -> false",
      "This machine only",
      "     (none)",
      "",
    ]);
  });

  test("pads module and file to the widest in the block", () => {
    const vscode: ChangeLine = {
      layer: "base",
      kind: "M",
      module: "vscode",
      file: "settings.json",
      what: "editor.fontSize: 14 -> 15",
    };
    const git: ChangeLine = {
      layer: "os",
      kind: "M",
      module: "git",
      file: ".gitconfig.local",
      what: "1 line(s) changed",
    };

    const block = groupBlock([vscode, git], undefined, "linux", "push");

    expect(block).toEqual([
      "Changes on this machine:",
      "",
      "All machines",
      "  1  M  vscode  settings.json     editor.fontSize: 14 -> 15",
      "Linux machines",
      "  2  M  git     .gitconfig.local  1 line(s) changed",
      "",
    ]);
  });

  test("widens numbers to two columns and (none) with them", () => {
    const lines = Array.from({ length: 11 }, (_, index) => baseLine(index + 1));

    const block = groupBlock(lines, undefined, "linux", "push");

    expect(block).toEqual([
      "Changes on this machine:",
      "",
      "All machines",
      "   1  M  parity  settings.json  key1: 1 -> 2",
      "   2  M  parity  settings.json  key2: 1 -> 2",
      "   3  M  parity  settings.json  key3: 1 -> 2",
      "   4  M  parity  settings.json  key4: 1 -> 2",
      "   5  M  parity  settings.json  key5: 1 -> 2",
      "   6  M  parity  settings.json  key6: 1 -> 2",
      "   7  M  parity  settings.json  key7: 1 -> 2",
      "   8  M  parity  settings.json  key8: 1 -> 2",
      "   9  M  parity  settings.json  key9: 1 -> 2",
      "  10  M  parity  settings.json  key10: 1 -> 2",
      "  11  M  parity  settings.json  key11: 1 -> 2",
      "Linux machines",
      "      (none)",
      "",
    ]);
  });

  test.each([
    ["windows", "Windows machines"],
    ["macos", "macOS machines"],
  ] as const)("names the %s OS group", (os, title) => {
    const block = groupBlock([OS_LINE], undefined, os, "push");

    expect(block[4]).toBe(title);
  });
});
