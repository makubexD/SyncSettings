import type { Profile } from "../config/profile.ts";
import type { ConfigV2, Os } from "../config/types.ts";
import type { Values } from "../values/sanitize.ts";
import type { ClaudeMode, MachineRecord } from "./record.ts";

export interface MachineScope {
  readonly on: readonly string[];
  readonly off: readonly {
    readonly module: string;
    readonly reason: string;
  }[];
}

/** The modules each Claude mode keeps off, per the contract's
 * "Modules on a machine". */
const CLAUDE_MODE_OFF: Readonly<Record<ClaudeMode, readonly string[]>> = {
  none: ["claude", "claude-worker"],
  claude: ["claude-worker"],
  "claude-deepseek": [],
};

/** The profile's modules, or every module for a machine without one, then
 * the record's `add`, each name once and in that order. */
function candidates(
  config: ConfigV2,
  profile: Profile | undefined,
  record: MachineRecord | undefined,
): readonly string[] {
  const listed =
    profile === undefined ? Object.keys(config.modules) : profile.modules;
  return [...new Set([...listed, ...(record?.modules.add ?? [])])];
}

/** Why a candidate is off, or `undefined` when it's on. The first rule that
 * matches wins, in the contract's order: `remove`, the module's own OS, then
 * the Claude mode. Without a record only the OS rule applies. */
function offReason(
  config: ConfigV2,
  module: string,
  record: MachineRecord | undefined,
  os: Os,
): string | undefined {
  if (record !== undefined && record.modules.remove.includes(module)) {
    return `${module} off on this machine`;
  }
  const moduleOses = config.modules[module]?.os;
  if (moduleOses !== undefined && !moduleOses.includes(os)) {
    return `${module} off, ${moduleOses.join(" or ")} only`;
  }
  if (record !== undefined && CLAUDE_MODE_OFF[record.claude].includes(module)) {
    return `${module} off by the Claude mode`;
  }
  return undefined;
}

/**
 * The modules this machine keeps on and the candidates it keeps off, with
 * the reason `mksync machine show` prints for each, per the contract's
 * "Modules on a machine".
 */
export function machineScope(
  config: ConfigV2,
  profile: Profile | undefined,
  record: MachineRecord | undefined,
  os: Os,
): MachineScope {
  const on: string[] = [];
  const off: { module: string; reason: string }[] = [];
  for (const module of candidates(config, profile, record)) {
    const reason = offReason(config, module, record, os);
    if (reason === undefined) {
      on.push(module);
    } else {
      off.push({ module, reason });
    }
  }
  return { on, off };
}

/**
 * The values a run hydrates with: the profile's, with the record's winning,
 * per the contract's "Values on a machine". `Object.fromEntries` keeps a
 * `__proto__` key as plain data.
 */
export function machineValues(
  profile: Profile | undefined,
  record: MachineRecord | undefined,
): Values {
  return Object.fromEntries([
    ...Object.entries(profile?.values ?? {}),
    ...Object.entries(record?.values ?? {}),
  ]);
}
