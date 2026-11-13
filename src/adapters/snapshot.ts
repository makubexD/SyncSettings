import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunCommand } from "../cli/parse.ts";
import { convertV1 } from "../core/config/convert.ts";
import type { Profile } from "../core/config/profile.ts";
import { parseProfile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  Os,
  Result as LoadResult,
} from "../core/config/types.ts";
import { parseV1 } from "../core/config/v1.ts";
import { parseV2 } from "../core/config/v2.ts";
import type { RepoFiles, Snapshot } from "../core/plan/types.ts";
import { parseValuesFile } from "../core/values/file.ts";
import type { Values } from "../core/values/sanitize.ts";
import { MACHINES_FOLDER, PROFILES_FOLDER, readSnapshot } from "./fs.ts";
import { readHead, readHeadTree, readPorcelain } from "./git.ts";

export const V1_CONFIG = "sync-config.json";

export const V2_CONFIG = "sync-config.v2.json";

const VALUES_FILE = ".user-values.json";

/** The folder holding a config, starting at `start` and walking up. */
export function findRepoRoot(start: string): string | undefined {
  let folder = start;
  for (;;) {
    if (
      existsSync(join(folder, V2_CONFIG)) ||
      existsSync(join(folder, V1_CONFIG))
    ) {
      return folder;
    }
    const parent = dirname(folder);
    if (parent === folder) {
      return undefined;
    }
    folder = parent;
  }
}

/** Read a text file, or `undefined` when it cannot be read. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Unreadable here means a broken clone, reported as an error by the caller.
    return undefined;
  }
}

/** Read a file's bytes, or `undefined` when it cannot be read. */
function readBytes(path: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Decision 2: `sync-config.v2.json` when it exists, else `sync-config.json`
 * converted in memory by the same converter that writes the v2 file.
 */
export function loadConfig(repoRoot: string): LoadResult<ConfigV2, ConfigError> {
  const unreadable = (file: string): LoadResult<ConfigV2, ConfigError> => ({
    ok: false,
    error: { message: `ERROR: cannot read ${file}.`, code: 1 },
  });

  const v2Path = join(repoRoot, V2_CONFIG);
  if (existsSync(v2Path)) {
    const text = readText(v2Path);
    return text === undefined ? unreadable(V2_CONFIG) : parseV2(text);
  }

  const text = readText(join(repoRoot, V1_CONFIG));
  if (text === undefined) {
    return unreadable(V1_CONFIG);
  }
  const v1 = parseV1(text);
  return v1.ok ? convertV1(v1.value) : v1;
}

/** `.user-values.json` next to the config, keyed by placeholder. */
function readValues(repoRoot: string): Values {
  return parseValuesFile(readText(join(repoRoot, VALUES_FILE)));
}

const LAYER_NAME = /^[a-z0-9-]+$/;

const PROFILE_VARIABLE = "SYNC_PROFILE";

const MACHINE_VARIABLE = "SYNC_MACHINE";

/** Layer names a profile or machine may not take: they name another layer. */
const RESERVED_LAYER_NAMES = ["linux", "macos", "windows", "common", "base"];

/** A run's profile and machine layers, as its environment chooses them. */
export interface Layers {
  readonly profile?: Profile;
  readonly machine?: string;
}

/** Contract "Profile and machine, until phase 6": unset or empty means no layer. */
function readLayerName(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
): LoadResult<string | undefined, ConfigError> {
  const value = env[variable];
  if (value === undefined || value === "") {
    return { ok: true, value: undefined };
  }
  if (!LAYER_NAME.test(value)) {
    return {
      ok: false,
      error: {
        message: `ERROR: ${variable} must be lowercase letters, digits and -; this is ${value}.`,
        code: 2,
      },
    };
  }
  return { ok: true, value };
}

/** Contract "Profile and machine, until phase 6": a layer name can't name another layer. */
function layerCollision(variable: string, name: string): ConfigError {
  return {
    message: `ERROR: ${variable} can't be ${name}: it names another layer.`,
    code: 2,
  };
}

/**
 * Contract "Profile and machine, until phase 6": the layers `SYNC_PROFILE` and
 * `SYNC_MACHINE` choose. A name outside lowercase letters, digits and `-`, a
 * reserved name, a machine that equals the profile, a profile file that is
 * missing, or one that doesn't parse stops the run with exit code 2 before any
 * file is touched.
 */
export function loadLayers(
  env: Readonly<Record<string, string | undefined>>,
  config: ConfigV2,
  stateFolder: string,
): LoadResult<Layers, ConfigError> {
  const profileName = readLayerName(env, PROFILE_VARIABLE);
  if (!profileName.ok) {
    return profileName;
  }
  const machine = readLayerName(env, MACHINE_VARIABLE);
  if (!machine.ok) {
    return machine;
  }
  if (
    profileName.value !== undefined &&
    RESERVED_LAYER_NAMES.includes(profileName.value)
  ) {
    return {
      ok: false,
      error: layerCollision(PROFILE_VARIABLE, profileName.value),
    };
  }
  if (
    machine.value !== undefined &&
    RESERVED_LAYER_NAMES.includes(machine.value)
  ) {
    return { ok: false, error: layerCollision(MACHINE_VARIABLE, machine.value) };
  }
  if (
    profileName.value !== undefined &&
    machine.value === profileName.value
  ) {
    return { ok: false, error: layerCollision(MACHINE_VARIABLE, machine.value) };
  }

  let profile: Profile | undefined;
  if (profileName.value !== undefined) {
    const name = profileName.value;
    const path = join(stateFolder, PROFILES_FOLDER, `${name}.json`);
    const text = readText(path);
    if (text === undefined) {
      return {
        ok: false,
        error: {
          message: `ERROR: profile ${name} not found: ${path}`,
          code: 2,
        },
      };
    }
    const parsed = parseProfile(name, text, config);
    if (!parsed.ok) {
      return parsed;
    }
    profile = parsed.value;
  }

  return {
    ok: true,
    value: {
      ...(profile !== undefined ? { profile } : {}),
      ...(machine.value !== undefined ? { machine: machine.value } : {}),
    },
  };
}

/**
 * The working tree an export preview compares with `HEAD`: the repo files the
 * snapshot read plus `sync-config.json`, which is never part of the export
 * plan. A config missing from the working tree stays absent, so `HEAD`'s copy
 * shows as a difference.
 */
export function previewWorkingTree(
  repoRoot: string,
  repoFiles: RepoFiles,
): RepoFiles {
  const tree = new Map(repoFiles);
  const config = readBytes(join(repoRoot, V1_CONFIG));
  if (config !== undefined) {
    tree.set(V1_CONFIG, config);
  }
  return tree;
}

/**
 * Build the snapshot the plan reads: the disk through `readSnapshot` (with the
 * profile and machine layers from the state folder), plus `HEAD` and the
 * porcelain status for the import's sync point, and `HEAD`'s bytes for an
 * export preview.
 */
export async function buildSnapshot(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  command: RunCommand,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  stateFolder: string,
  layers: Layers,
): Promise<Snapshot> {
  const snapshot = readSnapshot({
    repoRoot,
    config,
    os,
    home,
    stateFolder,
    cwd,
    values: readValues(repoRoot),
    env,
    only: command.only,
    force: command.force,
    ...(layers.profile !== undefined ? { profile: layers.profile } : {}),
    ...(layers.machine !== undefined ? { machine: layers.machine } : {}),
  });
  if (command.command === "export" && !command.preview) {
    return snapshot;
  }

  const [head, porcelain] = await Promise.all([
    readHead(repoRoot),
    readPorcelain(repoRoot),
  ]);
  const git: { head?: string; porcelain?: string; headFiles?: RepoFiles } = {};
  if (head !== undefined) {
    git.head = head;
  }
  if (porcelain !== undefined) {
    git.porcelain = porcelain;
  }
  if (command.command === "export" && command.preview && head !== undefined) {
    const headFiles = await readHeadTree(repoRoot);
    if (headFiles !== undefined) {
      git.headFiles = headFiles;
    }
  }
  return { ...snapshot, ...git };
}
