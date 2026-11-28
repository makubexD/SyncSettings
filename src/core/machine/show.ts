import type { ClaudeMode, MachineRecord } from "./record.ts";
import type { MachineScope } from "./scope.ts";

/** The column every label's value starts in, per the contract's six lines;
 * `profile show` uses it too. */
const LABEL_WIDTH = 10;

/** The contract's second setup question as `machine show` prints it. */
const CLAUDE_LABELS: Readonly<Record<ClaudeMode, string>> = {
  none: "none",
  claude: "Claude only",
  "claude-deepseek": "Claude plus DeepSeek",
};

const PUSH_MODE = "push with a preview";

const PULL_ONLY_MODE = "pull only";

/** What a `show` line prints for an empty list. */
export const NONE = "none";

const RETIRED = "retired";

/** One `show` line: the label padded to the value column, then the value. */
export function showLine(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

/** `on` joined, then each off reason in brackets joined by `; `, or `none`. */
function modulesLine(scope: MachineScope): string {
  const on = scope.on.length === 0 ? NONE : scope.on.join(", ");
  if (scope.off.length === 0) {
    return on;
  }
  const off = scope.off.map((item) => item.reason).join("; ");
  return `${on} (${off})`;
}

/**
 * `mksync machine show`'s lines, per the contract's "mksync machine show":
 * six lines, the record's name, profile, os, Claude answer and mode, and the
 * modules machineScope keeps on with its reasons for the rest. A retired
 * record adds the seventh `retired   yes` line.
 */
export function renderMachineShow(
  record: MachineRecord,
  scope: MachineScope,
): readonly string[] {
  const lines = [
    showLine("machine", record.name),
    showLine("profile", record.profile),
    showLine("os", record.os),
    showLine("claude", CLAUDE_LABELS[record.claude]),
    showLine("mode", record.pullOnly ? PULL_ONLY_MODE : PUSH_MODE),
    showLine("modules", modulesLine(scope)),
  ];
  if (record.retired) {
    lines.push(showLine(RETIRED, "yes"));
  }
  return lines;
}
