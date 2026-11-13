import { describe, expect, test } from "bun:test";
import type { MachineRecord } from "./record.ts";
import type { MachineScope } from "./scope.ts";
import { renderMachineShow } from "./show.ts";

const RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "windows",
  hostname: "wk1-laptop",
  domain: null,
  claude: "claude",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const SCOPE: MachineScope = {
  on: ["work-base", "git", "shell", "vscode", "claude"],
  off: [
    {
      module: "windows-terminal",
      reason: "windows-terminal off on this machine",
    },
  ],
};

function recordWith(overrides: Partial<MachineRecord>): MachineRecord {
  return { ...RECORD, ...overrides };
}

function scopeWith(overrides: Partial<MachineScope>): MachineScope {
  return { ...SCOPE, ...overrides };
}

describe("renderMachineShow", () => {
  test("prints the contract's six lines", () => {
    // Act
    const lines = renderMachineShow(RECORD, SCOPE);

    // Assert
    expect(lines).toEqual([
      "machine   wk1-laptop",
      "profile   work-1",
      "os        windows",
      "claude    Claude only",
      "mode      push with a preview",
      "modules   work-base, git, shell, vscode, claude (windows-terminal off on this machine)",
    ]);
  });

  test("joins the off reasons with ; in one bracket", () => {
    // Arrange
    const scope = scopeWith({
      off: [
        {
          module: "windows-terminal",
          reason: "windows-terminal off, linux only",
        },
        {
          module: "claude-worker",
          reason: "claude-worker off by the Claude mode",
        },
      ],
    });

    // Act
    const lines = renderMachineShow(RECORD, scope);

    // Assert
    expect(lines[5]).toBe(
      "modules   work-base, git, shell, vscode, claude (windows-terminal off, linux only; claude-worker off by the Claude mode)",
    );
  });

  test("says none when no module is on", () => {
    // Arrange
    const scope: MachineScope = {
      on: [],
      off: [{ module: "git", reason: "git off on this machine" }],
    };

    // Act
    const lines = renderMachineShow(RECORD, scope);

    // Assert
    expect(lines[5]).toBe("modules   none (git off on this machine)");
  });

  test("leaves the brackets out when nothing is off", () => {
    // Act
    const lines = renderMachineShow(RECORD, scopeWith({ off: [] }));

    // Assert
    expect(lines[5]).toBe("modules   work-base, git, shell, vscode, claude");
  });

  test("prints pull only for a pull-only record", () => {
    // Act
    const lines = renderMachineShow(recordWith({ pullOnly: true }), SCOPE);

    // Assert
    expect(lines[4]).toBe("mode      pull only");
  });

  test("prints each Claude answer as the contract labels it", () => {
    // Act
    const none = renderMachineShow(recordWith({ claude: "none" }), SCOPE);
    const deepseek = renderMachineShow(
      recordWith({ claude: "claude-deepseek" }),
      SCOPE,
    );

    // Assert
    expect(none[3]).toBe("claude    none");
    expect(deepseek[3]).toBe("claude    Claude plus DeepSeek");
  });

  test("adds the retired line to a retired record", () => {
    // Act
    const lines = renderMachineShow(recordWith({ retired: true }), SCOPE);

    // Assert
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe("retired   yes");
  });

  test("leaves the retired line out of a live record", () => {
    // Act
    const lines = renderMachineShow(RECORD, SCOPE);

    // Assert
    expect(lines).toHaveLength(6);
  });
});
