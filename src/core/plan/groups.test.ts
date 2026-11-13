import { describe, expect, test } from "bun:test";
import {
  groupBlock,
  groupedBlock,
  withoutNewSettings,
} from "./groups.ts";
import type { ChangeLine, NewSettingLine } from "./types.ts";

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

const NEW_ITEM: NewSettingLine = {
  module: "parity",
  file: "settings.json",
  path: "delta[]",
  kind: "item",
  what: 'delta[]: "new item"',
};

const GOES_TO = "goes to: profile work-1 (asked by mksync export)";

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

  test("prints the same block when there are no new settings", () => {
    const block = groupBlock([BASE_LINE], RECORD, "linux", "push", [], []);

    expect(block).toEqual([
      "Changes on wk1-laptop (profile work-1):",
      "",
      "All machines",
      "  1  M  parity  settings.json  baseKey: 1 -> 2",
      "Linux machines",
      "     (none)",
      "Profile work-1",
      "     (none)",
      "This machine only",
      "     (none)",
      "",
    ]);
  });

  test("numbers new settings after the groups and indents their notes to the kind column", () => {
    const block = groupBlock(
      [BASE_LINE, OS_LINE, PROFILE_LINE],
      RECORD,
      "linux",
      "push",
      [NEW_ITEM],
      [GOES_TO],
    );

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
      "New settings",
      '  4  +  parity  settings.json  delta[]: "new item"',
      `     ${GOES_TO}`,
      "",
    ]);
  });

  test("widens the columns over the change lines and the new settings", () => {
    const git: ChangeLine = {
      layer: "base",
      kind: "M",
      module: "git",
      file: "x",
      what: "1 line(s) changed",
    };
    const setting: NewSettingLine = {
      module: "vscode",
      file: "settings.json",
      path: "chat.agent.enabled",
      kind: "key",
      what: "chat.agent.enabled: true",
    };

    const block = groupedBlock([git], undefined, "linux", "push", [setting]);

    expect(block.head).toContain(
      "  1  M  git     x              1 line(s) changed",
    );
    expect(block.settings).toEqual([
      "  2  +  vscode  settings.json  chat.agent.enabled: true",
    ]);
    expect(block.indent).toBe("     ");
  });
});

describe("withoutNewSettings", () => {
  const answered: ChangeLine = {
    layer: "profile",
    kind: "+",
    module: "parity",
    file: "settings.json",
    what: 'delta[]: "new item"',
  };

  test("drops the change line of an answered new setting", () => {
    expect(withoutNewSettings([answered], [NEW_ITEM])).toEqual([]);
  });

  test("keeps a change line whose value differs", () => {
    const other: ChangeLine = { ...answered, what: 'delta[]: "other item"' };

    expect(withoutNewSettings([other], [NEW_ITEM])).toEqual([other]);
  });

  test.each([
    ["module", { module: "vscode" }],
    ["file", { file: "other.json" }],
  ] as const)("keeps a change line with another %s", (_, change) => {
    const other: ChangeLine = { ...answered, ...change };

    expect(withoutNewSettings([other], [NEW_ITEM])).toEqual([other]);
  });
});
