/**
 * The hidden `shadow` command: run the program's plan and the old engine's
 * script over the same snapshot, compare what they would write, and append
 * the comparison to the state folder's shadow log.
 */

import { appendShadowLog, engineShadow } from "../adapters/engine.ts";
import type { EngineHost } from "../adapters/engine.ts";
import { buildSnapshot } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import { failure } from "./export.ts";
import type { Result } from "./export.ts";
import type { RunCommand } from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { compareShadow, programShadow, renderShadow } from "../core/shadow.ts";

/**
 * The command whose snapshot shadow reuses: an export preview, which also
 * reads `HEAD`'s bytes. Shadow runs the same plans without printing them.
 */
const SHADOW_SNAPSHOT_COMMAND: RunCommand = {
  kind: "run",
  command: "export",
  force: false,
  preview: true,
  check: false,
  resetValues: false,
  yes: false,
  only: [],
};

/** The host whose old-engine scripts shadow runs, from the real platform. */
function hostOf(platform: string): EngineHost {
  return platform === "win32" ? "windows" : "posix";
}

/** Run the hidden shadow comparisons against the repo found from here. */
export async function executeShadow(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  layers: Layers,
): Promise<Result> {
  try {
    const snapshot = await buildSnapshot(
      repoRoot,
      config,
      os,
      home,
      SHADOW_SNAPSHOT_COMMAND,
      process.cwd(),
      process.env,
      layers,
    );
    const program = programShadow(snapshot);
    const engine = await engineShadow(
      repoRoot,
      hostOf(process.platform),
      process.env,
    );
    const rendered = renderShadow(
      compareShadow(program, engine),
      new Date().toISOString(),
    );
    let stderr = "";
    try {
      appendShadowLog(state, rendered.logText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr = `WARNING: cannot write the shadow log: ${message}\n`;
    }
    return { code: rendered.code, stdout: rendered.stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`ERROR: ${message}`);
  }
}
