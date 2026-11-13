import type { Profile } from "../config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
} from "../config/types.ts";

const BASE_ROOT = "dotfiles/common/";

const ALL_OS: readonly Os[] = ["windows", "linux", "macos"];

/** The host OS names mapped to the contract's OS names. */
const PLATFORM_OS: Readonly<Record<string, Os | undefined>> = {
  linux: "linux",
  darwin: "macos",
  win32: "windows",
};

/** The four layer slots, in layer order. */
export type LayerName = "base" | "os" | "profile" | "machine";

export interface Layer {
  readonly name: LayerName;
  /** The status line's label: "base", the OS name, or the profile's or
   * machine's name. */
  readonly label: string;
  readonly root: string;
  readonly repoPath: string;
}

/** What this run has: its OS, the profile and machine chosen for it, and the
 * modules it keeps on. Without a profile `modules` is absent and every module
 * is on. */
export interface SelectScope {
  readonly os: Os;
  readonly profile?: Profile;
  readonly machine?: string;
  readonly modules?: readonly string[];
}

export interface SelectedEntry {
  readonly entry: ConfigV2Entry;
  /** Every layer this run has for the entry, in layer order, whether or not
   * the layer holds a file. An export may create a missing file. */
  readonly slots: readonly Layer[];
  /** Only the layers whose file exists, in layer order. */
  readonly layers: readonly Layer[];
  readonly source: Layer | undefined;
  readonly writeRoot: string;
}

interface LayerRoot {
  readonly name: LayerName;
  readonly label: string;
  readonly root: string;
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

// Contract "Which system": SYNC_OS when set, else the host's own OS. Off
// Windows only linux and macos are accepted; on Windows only windows.
export function pickOs(
  syncOs: string | undefined,
  host: string,
): Result<Os, ConfigError> {
  const hostOs = PLATFORM_OS[host];
  if (syncOs !== undefined && syncOs !== "") {
    if (hostOs === "windows") {
      return syncOs === "windows"
        ? { ok: true, value: syncOs }
        : unsupportedOs(syncOs);
    }
    return syncOs === "linux" || syncOs === "macos"
      ? { ok: true, value: syncOs }
      : unsupportedOs(syncOs);
  }
  return hostOs === undefined
    ? unsupportedOs(host)
    : { ok: true, value: hostOs };
}

function osRoot(os: Os): string {
  return `dotfiles/${os}/`;
}

// The layer roots in layer order: base, OS, then the profile and the machine
// when this run has one. Profile and machine paths are named the way the
// snapshot does; the adapter maps them to the state folder.
function rootsFor(scope: SelectScope): readonly LayerRoot[] {
  const roots: LayerRoot[] = [
    { name: "base", label: "base", root: BASE_ROOT },
    { name: "os", label: scope.os, root: osRoot(scope.os) },
  ];
  if (scope.profile !== undefined) {
    roots.push({
      name: "profile",
      label: scope.profile.name,
      root: `profiles/${scope.profile.name}/`,
    });
  }
  if (scope.machine !== undefined) {
    roots.push({
      name: "machine",
      label: scope.machine,
      root: `machines/${scope.machine}/`,
    });
  }
  return roots;
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

/** The layer slot for `entry` under `layerRoot`; a slot exists whether or not
 * the repo holds its file. */
function layerAt(layerRoot: LayerRoot, entry: ConfigV2Entry): Layer {
  return {
    name: layerRoot.name,
    label: layerRoot.label,
    root: layerRoot.root,
    repoPath: `${layerRoot.root}${entry.file}`,
  };
}

// A slot has a layer when the file is there, or, for a directory entry, when
// any snapshot path sits under its folder.
function slotHasLayer(
  layer: Layer,
  entry: ConfigV2Entry,
  files: ReadonlySet<string>,
): boolean {
  if (files.has(layer.repoPath)) {
    return true;
  }
  if (entry.merge === "dir") {
    const prefix = `${layer.repoPath}/`;
    for (const path of files) {
      if (path.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

// Decision 3: the base root for no os or more than one, else that OS's root.
function writeRootFor(os: readonly Os[]): string {
  const [only] = os;
  return os.length === 1 && only !== undefined ? osRoot(only) : BASE_ROOT;
}

// Contract "Layers (program only)": with a profile, an entry whose module the
// profile doesn't keep on is off, and an entry for another system stays off too.
export function selectEntries(
  config: ConfigV2,
  scope: SelectScope,
  files: ReadonlySet<string>,
): Result<SelectedEntry[], ConfigError> {
  const roots = rootsFor(scope);
  const selected: SelectedEntry[] = [];
  for (const entry of config.entries) {
    if (scope.modules !== undefined && !scope.modules.includes(entry.module)) {
      continue;
    }
    const osList = effectiveOs(config, entry);
    if (!osList.includes(scope.os)) {
      continue;
    }
    const slots: Layer[] = [];
    const layers: Layer[] = [];
    for (const root of roots) {
      const layer = layerAt(root, entry);
      slots.push(layer);
      if (slotHasLayer(layer, entry, files)) {
        layers.push(layer);
      }
    }
    selected.push({
      entry,
      slots,
      layers,
      source: layers[layers.length - 1],
      writeRoot: writeRootFor(osList),
    });
  }
  return { ok: true, value: selected };
}
