import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync,
} from "node:fs";
import { hostname as hostName } from "node:os";
import { join } from "node:path";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { effectiveOs } from "../core/layers/select.ts";
import type { MachineIdentity } from "../core/machine/check.ts";
import { resolvedLocal } from "../core/plan/pick.ts";

/** The Windows domain `USERDNSDOMAIN` holds, lowercased, or `null` when it is
 * missing or empty. */
function windowsDomain(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const domain = env.USERDNSDOMAIN;
  return domain === undefined || domain === "" ? null : domain.toLowerCase();
}

/** Decision 2: `SYNC_DOMAIN` when set, with an empty value meaning no domain;
 * otherwise the Windows domain, and `null` on the other systems. */
function domainOf(
  env: Readonly<Record<string, string | undefined>>,
  os: Os,
): string | null {
  const override = env.SYNC_DOMAIN;
  if (override !== undefined) {
    return override === "" ? null : override;
  }
  return os === "windows" ? windowsDomain(env) : null;
}

/**
 * What the scan reads about this machine (decision 8's check): its OS, its
 * hostname and its domain. Decision 2: `SYNC_HOSTNAME` and `SYNC_DOMAIN`
 * replace what the scan reads, so shared cases print the same on every
 * runner; the hostname is lowercased either way.
 */
export function readIdentity(
  env: Readonly<Record<string, string | undefined>>,
  os: Os,
): MachineIdentity {
  const hostname = (env.SYNC_HOSTNAME ?? hostName()).toLowerCase();
  return { os, hostname, domain: domainOf(env, os) };
}

/** Contract "The scan": the tools the scan looks for, in print order. */
const SCAN_TOOLS = [
  "git",
  "gh",
  "jq",
  "code",
  "claude",
  "tmux",
  "starship",
  "wezterm",
  "htop",
  "rtk",
] as const;

/** The extensions Windows looks for when a command has none of its own. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** What the scan reports about this machine (contract "The scan"). */
export interface Scan {
  readonly os: Os;
  readonly hostname: string;
  readonly domain: string | null;
  readonly gitEmail: string | null;
  readonly tools: {
    readonly found: readonly string[];
    readonly missing: readonly string[];
  };
  readonly files: {
    readonly existing: number;
    readonly total: number;
  };
}

/**
 * Contract "The scan": the global git email, shown and never stored. `env` is
 * the child's whole environment, so `HOME` decides which global config git
 * reads. An empty answer, a failure to start git and a non-zero exit are all
 * `null`.
 */
async function readGitEmail(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  try {
    const child = Bun.spawn(["git", "config", "--global", "user.email"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = new Uint8Array(
      await new Response(child.stdout).arrayBuffer(),
    );
    const code = await child.exited;
    if (code !== 0) {
      return null;
    }
    const email = new TextDecoder().decode(stdout).trim();
    return email === "" ? null : email;
  } catch {
    // A missing git binary is "no email", not a failure of the scan.
    return null;
  }
}

/** Whether `path` is a regular file this OS would run. */
function isExecutableFile(path: string, os: Os): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    return false;
  }
  if (os === "windows") {
    return true;
  }
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One tool's absolute candidates under `dir`: the name, plus each Windows
 * `PATHEXT` extension there. */
function candidatesIn(
  dir: string,
  name: string,
  os: Os,
  extensions: readonly string[],
): readonly string[] {
  if (os === "windows") {
    return extensions.map((extension) => join(dir, `${name}${extension}`));
  }
  return [join(dir, name)];
}

function isOnPath(
  name: string,
  dirs: readonly string[],
  os: Os,
  extensions: readonly string[],
): boolean {
  return dirs.some(
    (dir) =>
      dir !== "" &&
      candidatesIn(dir, name, os, extensions).some((path) =>
        isExecutableFile(path, os),
      ),
  );
}

function splitTools(has: (tool: string) => boolean): Scan["tools"] {
  const found: string[] = [];
  const missing: string[] = [];
  for (const tool of SCAN_TOOLS) {
    if (has(tool)) {
      found.push(tool);
    } else {
      missing.push(tool);
    }
  }
  return { found, missing };
}

/**
 * Contract "The scan": `SYNC_TOOLS`'s comma list replaces the `PATH` search,
 * and a name not in the contract list is ignored. Both lists keep the
 * contract's order.
 */
function scanTools(
  env: Readonly<Record<string, string | undefined>>,
  os: Os,
): Scan["tools"] {
  const override = env.SYNC_TOOLS;
  if (override !== undefined) {
    const named = new Set(
      override
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    );
    return splitTools((tool) => named.has(tool));
  }
  const dirs = (env.PATH ?? "").split(os === "windows" ? ";" : ":");
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(";")
    .filter((extension) => extension !== "");
  return splitTools((tool) => isOnPath(tool, dirs, os, extensions));
}

/** How many of this OS's entries, and how many already exist locally. */
function countFiles(config: ConfigV2, os: Os, home: string): Scan["files"] {
  let existing = 0;
  let total = 0;
  for (const entry of config.entries) {
    if (!effectiveOs(config, entry).includes(os)) {
      continue;
    }
    total++;
    if (existsSync(resolvedLocal(entry, os, home))) {
      existing++;
    }
  }
  return { existing, total };
}

/**
 * Contract "The scan": what `setup` reads about this machine before asking
 * anything. Decision 2's `SYNC_*` variables replace the hostname, the domain
 * and the tools, so shared cases print the same on every runner.
 */
export async function readScan(
  env: Readonly<Record<string, string | undefined>>,
  os: Os,
  home: string,
  config: ConfigV2,
): Promise<Scan> {
  return {
    ...readIdentity(env, os),
    gitEmail: await readGitEmail(env),
    tools: scanTools(env, os),
    files: countFiles(config, os, home),
  };
}
