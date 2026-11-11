import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
} from "../config/types.ts";

const BASE_ROOT = "dotfiles/common/";

const ALL_OS: readonly Os[] = ["windows", "linux", "macos"];

const SYSTEM_OS: Readonly<Record<string, Os>> = {
  Linux: "linux",
  Darwin: "macos",
  Windows_NT: "windows",
};

export interface Layer {
  readonly root: string;
  readonly repoPath: string;
}

export interface SelectedEntry {
  readonly entry: ConfigV2Entry;
  readonly layers: readonly Layer[];
  readonly source: Layer | undefined;
  readonly writeRoot: string;
}

function unsupportedOs(value: string): Result<Os, ConfigError> {
  return {
    ok: false,
    error: {
      message: `ERROR: SyncSettings runs on Linux, macOS and Windows; this is ${value}.`,
      code: 1,
    },
  };
}

// Contract "Which system": SYNC_OS when set, else the uname -s name.
export function pickOs(
  syncOs: string | undefined,
  systemName: string,
): Result<Os, ConfigError> {
  if (syncOs !== undefined && syncOs !== "") {
    if (syncOs === "linux" || syncOs === "macos") {
      return { ok: true, value: syncOs };
    }
    return unsupportedOs(syncOs);
  }
  const system = SYSTEM_OS[systemName];
  if (system !== undefined) {
    return { ok: true, value: system };
  }
  return unsupportedOs(systemName);
}

function osRoot(os: Os): string {
  return `dotfiles/${os}/`;
}

// Entry os over module os over all three.
function effectiveOs(config: ConfigV2, entry: ConfigV2Entry): readonly Os[] {
  if (entry.os !== undefined) {
    return entry.os;
  }
  const module = config.modules[entry.module];
  if (module?.os !== undefined) {
    return module.os;
  }
  return ALL_OS;
}

// A layer exists when the file is there, or, for a directory entry, when any
// snapshot path sits under its folder.
function layerOf(
  root: string,
  entry: ConfigV2Entry,
  files: ReadonlySet<string>,
): Layer | undefined {
  const repoPath = `${root}${entry.file}`;
  if (files.has(repoPath)) {
    return { root, repoPath };
  }
  if (entry.merge === "dir") {
    const prefix = `${repoPath}/`;
    for (const path of files) {
      if (path.startsWith(prefix)) {
        return { root, repoPath };
      }
    }
  }
  return undefined;
}

// Decision 3: the base root for no os or more than one, else that OS's root.
function writeRootFor(os: readonly Os[]): string {
  const [only] = os;
  return os.length === 1 && only !== undefined ? osRoot(only) : BASE_ROOT;
}

function sourceOf(
  entry: ConfigV2Entry,
  layers: readonly Layer[],
): Result<Layer | undefined, ConfigError> {
  if ((entry.merge === "json" || entry.merge === "import") && layers.length > 1) {
    return {
      ok: false,
      error: {
        message: `ERROR: ${entry.file}: merge type ${entry.merge} needs more than one layer; not supported yet`,
        code: 1,
      },
    };
  }
  return { ok: true, value: layers[layers.length - 1] };
}

// Contract "Entry selection": entries in config order whose effective os list
// holds this system, each with its existing base and OS layers.
export function selectEntries(
  config: ConfigV2,
  os: Os,
  files: ReadonlySet<string>,
): Result<SelectedEntry[], ConfigError> {
  const selected: SelectedEntry[] = [];
  for (const entry of config.entries) {
    const osList = effectiveOs(config, entry);
    if (!osList.includes(os)) {
      continue;
    }
    const layers: Layer[] = [];
    for (const root of [BASE_ROOT, osRoot(os)]) {
      const layer = layerOf(root, entry, files);
      if (layer !== undefined) {
        layers.push(layer);
      }
    }
    const source = sourceOf(entry, layers);
    if (!source.ok) {
      return source;
    }
    selected.push({
      entry,
      layers,
      source: source.value,
      writeRoot: writeRootFor(osList),
    });
  }
  return { ok: true, value: selected };
}
