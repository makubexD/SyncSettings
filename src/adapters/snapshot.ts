import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunCommand } from "../cli/parse.ts";
import type { Profile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  Os,
  Result as LoadResult,
} from "../core/config/types.ts";
import { parseV2 } from "../core/config/v2.ts";
import { selectEntries } from "../core/layers/select.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { machineValues } from "../core/machine/scope.ts";
import { scopeFor } from "../core/plan/pick.ts";
import type { DconfDumpResult, RepoFiles, Snapshot } from "../core/plan/types.ts";
import { parseValuesFile } from "../core/values/file.ts";
import type { Values } from "../core/values/sanitize.ts";
import { dconfDump, loginHome } from "./dconf.ts";
import { findRepoSymlink, readSnapshot } from "./fs.ts";
import { readHead, readHeadTree, readPorcelain } from "./git.ts";
import { readStore, readText } from "./store.ts";
import type { StoreLocation } from "./store.ts";

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

/** Decision 7's refusal of a v1 `sync-config.json`. */
const OLD_CONFIG_ERROR: ConfigError = {
  message: "ERROR: sync-config.json: needs schemaVersion 2; this is an old config.",
  code: 2,
};

/**
 * True when `text` is JSON giving a plain object with no `schemaVersion`: a v1
 * config. Text that is not a JSON object is left to `parseV2`'s own error.
 */
function isOldConfig(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: parseV2 reports it.
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    !Object.hasOwn(parsed, "schemaVersion")
  );
}

/**
 * Decision 8: the old clone's `sync-config.v2.json` when it exists, else
 * `sync-config.json`; both are parsed as v2. Decision 7: a `sync-config.json`
 * with no `schemaVersion` is an old v1 config and stops with its own line and
 * exit 2. Contract "Path safety": a symlink under `dotfiles/` stops the run
 * before it touches a file.
 */
export function loadConfig(
  repoRoot: string,
): LoadResult<ConfigV2, ConfigError> {
  const unreadable = (file: string): LoadResult<ConfigV2, ConfigError> => ({
    ok: false,
    error: { message: `ERROR: cannot read ${file}.`, code: 1 },
  });

  let loaded: LoadResult<ConfigV2, ConfigError>;
  const v2Path = join(repoRoot, V2_CONFIG);
  if (existsSync(v2Path)) {
    const text = readText(v2Path);
    loaded = text === undefined ? unreadable(V2_CONFIG) : parseV2(text, V2_CONFIG);
  } else {
    const text = readText(join(repoRoot, V1_CONFIG));
    if (text === undefined) {
      return unreadable(V1_CONFIG);
    }
    loaded = isOldConfig(text)
      ? { ok: false, error: OLD_CONFIG_ERROR }
      : parseV2(text, V1_CONFIG);
  }
  if (!loaded.ok) {
    return loaded;
  }
  const error = findRepoSymlink(repoRoot, loaded.value);
  return error === undefined ? loaded : { ok: false, error };
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
  /** The store the layers were read from: writes and layer reads go there. */
  readonly location: StoreLocation;
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
  const { profile, record, location } = store.value;
  return {
    ok: true,
    value: {
      location,
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
 * Contract "dconf entries": on Linux, `dconf dump` each selected dconf entry's
 * folder once per distinct path. Windows and macOS never run dconf, so they
 * get no dumps and a dconf entry stays `SKIPPED`, as the PowerShell engine's
 * does.
 */
async function dconfDumpsFor(
  snapshot: Snapshot,
): Promise<ReadonlyMap<string, DconfDumpResult> | undefined> {
  if (snapshot.os !== "linux") {
    return undefined;
  }
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return undefined;
  }
  const paths = new Set<string>();
  for (const chosen of selected.value) {
    const path = chosen.entry.dconfPath;
    if (chosen.entry.merge === "dconf" && path !== undefined) {
      paths.add(path);
    }
  }
  if (paths.size === 0) {
    return undefined;
  }
  const dumps = await Promise.all(
    [...paths].map(
      async (path) => [path, await dconfDump(path, snapshot.env)] as const,
    ),
  );
  return new Map(dumps);
}

/**
 * Build the snapshot the plan reads: the disk through `readSnapshot` (with the
 * profile, machine and record layers the record store holds), the dconf dumps
 * an export compares, plus `HEAD` and the porcelain status for the import's
 * sync point, and `HEAD`'s bytes for an export preview. Decision 4: with a
 * record the values come from the profile and the record, and
 * `.user-values.json` is not read.
 */
export async function buildSnapshot(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  command: RunCommand,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
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
    location: layers.location,
    cwd,
    values,
    env,
    only: command.only,
    force: command.force,
    ...(layers.profile !== undefined ? { profile: layers.profile } : {}),
    ...(layers.machine !== undefined ? { machine: layers.machine } : {}),
    ...(layers.record !== undefined ? { record: layers.record } : {}),
  });
  const dconfDumps = await dconfDumpsFor(snapshot);
  let built = snapshot;
  if (dconfDumps !== undefined) {
    // The login home is the real uid's, not `$USER`'s: with `sudo` or a
    // rewritten environment the two can differ.
    const uid = process.getuid?.();
    const login =
      uid === undefined
        ? undefined
        : await loginHome(String(uid), snapshot.env);
    built = {
      ...snapshot,
      dconfDumps,
      ...(login !== undefined ? { loginHome: login } : {}),
    };
  }
  if (command.command === "export" && !command.preview) {
    return built;
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
  return { ...built, ...git };
}
