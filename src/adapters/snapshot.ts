import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunCommand } from "../cli/parse.ts";
import { convertV1 } from "../core/config/convert.ts";
import type { Profile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  Os,
  Result as LoadResult,
} from "../core/config/types.ts";
import { parseV1 } from "../core/config/v1.ts";
import { parseV2 } from "../core/config/v2.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { machineValues } from "../core/machine/scope.ts";
import type { RepoFiles, Snapshot } from "../core/plan/types.ts";
import { parseValuesFile } from "../core/values/file.ts";
import type { Values } from "../core/values/sanitize.ts";
import { readSnapshot } from "./fs.ts";
import { readHead, readHeadTree, readPorcelain } from "./git.ts";
import { readStore, readText } from "./store.ts";

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
export function loadConfig(
  repoRoot: string,
): LoadResult<ConfigV2, ConfigError> {
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

/** A run's profile, machine and record layers, as the record store holds them. */
export interface Layers {
  readonly profile?: Profile;
  readonly machine?: string;
  readonly record?: MachineRecord;
}

/**
 * Contract "Where records are kept": the layers the machine's record chooses.
 * No record means no profile or machine layer. A bad record, or one whose
 * profile file is missing, stops the run with exit code 2 before any file is
 * touched.
 */
export function loadLayers(
  stateFolder: string,
  repoRoot: string,
  config: ConfigV2,
): LoadResult<Layers, ConfigError> {
  const store = readStore(stateFolder, repoRoot, config);
  if (!store.ok) {
    return store;
  }
  const { profile, record } = store.value;
  return {
    ok: true,
    value: {
      ...(profile !== undefined ? { profile } : {}),
      ...(record !== undefined ? { machine: record.name, record } : {}),
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
 * profile, machine and record layers the record store holds), plus `HEAD` and
 * the porcelain status for the import's sync point, and `HEAD`'s bytes for an
 * export preview. Decision 4: with a record the values come from the profile
 * and the record, and `.user-values.json` is not read.
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
  const values =
    layers.record !== undefined
      ? machineValues(layers.profile, layers.record)
      : readValues(repoRoot);
  const snapshot = readSnapshot({
    repoRoot,
    config,
    os,
    home,
    stateFolder,
    cwd,
    values,
    env,
    only: command.only,
    force: command.force,
    ...(layers.profile !== undefined ? { profile: layers.profile } : {}),
    ...(layers.machine !== undefined ? { machine: layers.machine } : {}),
    ...(layers.record !== undefined ? { record: layers.record } : {}),
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
