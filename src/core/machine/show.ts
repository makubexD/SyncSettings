import type { ClaudeMode, MachineRecord } from "./record.ts";
import type { MachineScope } from "./scope.ts";

/** The column every label's value starts in, per the contract's six lines. */
const LABEL_WIDTH = 10;

/** The contract's second setup question as `machine show` prints it. */
const CLAUDE_LABELS: Readonly<Record<ClaudeMode, string>> = {
  none: "none",
  claude: "Claude only",
  "claude-deepseek": "Claude plus DeepSeek",
};

const PUSH_MODE = "push with a preview";

const PULL_ONLY_MODE = "pull only";

const NONE = "none";

const RETIRED = "retired";

function line(label: string, value: string): string {
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
    line("machine", record.name),
    line("profile", record.profile),
    line("os", record.os),
    line("claude", CLAUDE_LABELS[record.claude]),
    line("mode", record.pullOnly ? PULL_ONLY_MODE : PUSH_MODE),
    line("modules", modulesLine(scope)),
  ];
  if (record.retired) {
    lines.push(line(RETIRED, "yes"));
  }
  return lines;
}
