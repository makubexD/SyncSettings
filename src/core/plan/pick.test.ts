import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import type {
  Layer,
  LayerName,
  SelectedEntry,
} from "../layers/select.ts";
import type { MachineRecord } from "../machine/record.ts";
import { onlySelected, resolveOnly, resolvedLocal, scopeFor } from "./pick.ts";
import type { Snapshot } from "./types.ts";

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {
    git: { description: "Git settings" },
    gnome: { description: "GNOME desktop", os: ["linux"] },
    claude: { description: "Claude settings" },
    "claude-worker": { description: "Claude worker settings" },
    other: { description: "Another module" },
  },
  entries: [],
};

const PROFILE: Profile = {
  name: "work-1",
  modules: ["git", "gnome"],
  values: {},
  destinations: {},
  retired: false,
};

function machineRecord(extra: Partial<MachineRecord> = {}): MachineRecord {
  return {
    name: "wk1-laptop",
    profile: "work-1",
    os: "windows",
    hostname: "wk1-laptop",
    domain: null,
    claude: "claude-deepseek",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: {},
    replaced: [],
    retired: false,
    ...extra,
  };
}

function snapshotWith(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    config: CONFIG,
    os: "linux",
    home: "/home/user",
    cwd: "/home/user",
    repoFiles: new Map(),
    localFiles: new Map(),
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
    ...extra,
  };
}

const DIR_ENTRY: ConfigV2Entry = {
  file: "dir",
  module: "git",
  merge: "dir",
  localPath: "~/.config/fixture/dir",
};

const DIR_SELECTED: SelectedEntry = {
  entry: DIR_ENTRY,
  slots: [],
  layers: [],
  source: undefined,
  writeRoot: "dotfiles/common/",
};

const PLAIN_ENTRY: ConfigV2Entry = {
  file: "plain.txt",
  module: "git",
  merge: "whole",
  localPath: "~/.config/fixture/plain.txt",
};

const PLAIN_SELECTED: SelectedEntry = {
  entry: PLAIN_ENTRY,
  slots: [],
  layers: [],
  source: undefined,
  writeRoot: "dotfiles/linux/",
};

const LAYER_ROOTS: Readonly<Record<LayerName, string>> = {
  base: "dotfiles/common/",
  os: "dotfiles/linux/",
  profile: "profiles/work-1/",
  machine: "machines/wk1-laptop/",
};

function layerFor(name: LayerName, file: string): Layer {
  return {
    name,
    label: name,
    root: LAYER_ROOTS[name],
    repoPath: `${LAYER_ROOTS[name]}${file}`,
  };
}

const JSON_ENTRY: ConfigV2Entry = {
  file: "settings.json",
  module: "git",
  merge: "json",
  localPath: "~/.config/fixture/settings.json",
};

function jsonSelected(...names: readonly LayerName[]): SelectedEntry {
  const layers = names.map((name) => layerFor(name, JSON_ENTRY.file));
  return {
    entry: JSON_ENTRY,
    slots: layers,
    layers,
    source: layers[layers.length - 1],
    writeRoot: LAYER_ROOTS.os,
  };
}

const WHOLE_PROFILE_ENTRY: ConfigV2Entry = {
  file: "plain.txt",
  module: "git",
  merge: "whole",
  localPath: "~/.config/fixture/plain.txt",
};

const WHOLE_PROFILE_LAYERS: readonly Layer[] = [
  layerFor("os", WHOLE_PROFILE_ENTRY.file),
  layerFor("profile", WHOLE_PROFILE_ENTRY.file),
];

const WHOLE_PROFILE_SELECTED: SelectedEntry = {
  entry: WHOLE_PROFILE_ENTRY,
  slots: WHOLE_PROFILE_LAYERS,
  layers: WHOLE_PROFILE_LAYERS,
  source: WHOLE_PROFILE_LAYERS[1],
  writeRoot: LAYER_ROOTS.os,
};

const JSON_BASE_LABEL = `${LAYER_ROOTS.base}${JSON_ENTRY.file}`;
const JSON_OS_LABEL = `${LAYER_ROOTS.os}${JSON_ENTRY.file}`;
const JSON_PROFILE_PATH = `${LAYER_ROOTS.profile}${JSON_ENTRY.file}`;

const MACOS_LOCAL_PATHS: ConfigV2Entry = {
  file: "m.txt",
  module: "git",
  merge: "whole",
  localPath: "~/.config/fixture/m.txt",
  localPaths: { macos: "~/.config/other/m.txt" },
};

const MACOS_SPACES_LOCAL_PATHS: ConfigV2Entry = {
  file: "settings.json",
  module: "git",
  merge: "whole",
  localPath: "~/.config/fixture/settings.json",
  localPaths: {
    macos: "~/Library/Application Support/Code/User/settings.json",
  },
};

const WINDOWS_LOCAL_PATHS: ConfigV2Entry = {
  file: "m.txt",
  module: "git",
  merge: "whole",
  localPath: "~/.config/fixture/m.txt",
  localPaths: { windows: "~/other/m.txt" },
};

const MACOS_HOME = "/Users/u";
const WINDOWS_HOME = "C:\\Users\\u";

describe("resolvedLocal", () => {
  test("should use the macOS localPaths value on macOS", () => {
    // Arrange
    const entry = MACOS_LOCAL_PATHS;

    // Act
    const local = resolvedLocal(entry, "macos", MACOS_HOME);

    // Assert
    expect(local).toBe("/Users/u/.config/other/m.txt");
  });

  test("should keep the default localPath on Linux", () => {
    // Arrange
    const entry = MACOS_LOCAL_PATHS;

    // Act
    const local = resolvedLocal(entry, "linux", MACOS_HOME);

    // Assert
    expect(local).toBe("/Users/u/.config/fixture/m.txt");
  });

  test("should keep the spaces in a macOS localPaths value", () => {
    // Arrange
    const entry = MACOS_SPACES_LOCAL_PATHS;

    // Act
    const local = resolvedLocal(entry, "macos", MACOS_HOME);

    // Assert
    expect(local).toBe(
      "/Users/u/Library/Application Support/Code/User/settings.json",
    );
  });

  test("should use the Windows localPaths value on Windows", () => {
    // Arrange
    const entry = WINDOWS_LOCAL_PATHS;

    // Act
    const local = resolvedLocal(entry, "windows", WINDOWS_HOME);

    // Assert
    expect(local).toBe("C:\\Users\\u\\other\\m.txt");
  });
});

describe("scopeFor", () => {
  test("should keep the profile's modules this OS allows", () => {
    // Arrange
    const snapshot = snapshotWith({
      os: "windows",
      profile: PROFILE,
      machine: "work-1",
    });

    // Act
    const scope = scopeFor(snapshot);

    // Assert
    expect(scope).toEqual({
      os: "windows",
      profile: PROFILE,
      machine: "work-1",
      modules: ["git"],
    });
  });

  test("should leave modules undefined without a profile or a record", () => {
    // Arrange
    const snapshot = snapshotWith();

    // Act
    const scope = scopeFor(snapshot);

    // Assert
    expect(scope).toEqual({ os: "linux" });
    expect("modules" in scope).toBe(false);
  });

  test("should build the modules from a record without a profile", () => {
    // Arrange
    const snapshot = snapshotWith({
      os: "linux",
      machine: "wk1-laptop",
      record: machineRecord({
        claude: "none",
        modules: { add: [], remove: ["other"] },
      }),
    });

    // Act
    const scope = scopeFor(snapshot);

    // Assert
    expect(scope.modules).toEqual(["git", "gnome"]);
  });

  test("should subtract the record's remove list from the profile's modules", () => {
    // Arrange
    const snapshot = snapshotWith({
      os: "linux",
      profile: PROFILE,
      machine: "wk1-laptop",
      record: machineRecord({
        modules: { add: ["other"], remove: ["gnome"] },
      }),
    });

    // Act
    const scope = scopeFor(snapshot);

    // Assert
    expect(scope.modules).toEqual(["git", "other"]);
  });
});

describe("resolveOnly", () => {
  test("should resolve a repo path to itself", () => {
    // Arrange
    const snapshot = snapshotWith({
      only: ["dotfiles/linux/plain.txt"],
      home: MACOS_HOME,
      cwd: MACOS_HOME,
    });

    // Act
    const outcome = resolveOnly(snapshot, [PLAIN_SELECTED]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: ["dotfiles/linux/plain.txt"] });
  });

  test("should resolve a ~/ path to the entry's repo path", () => {
    // Arrange
    const snapshot = snapshotWith({
      only: ["~/.config/fixture/plain.txt"],
      home: MACOS_HOME,
      cwd: MACOS_HOME,
    });

    // Act
    const outcome = resolveOnly(snapshot, [PLAIN_SELECTED]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: ["dotfiles/linux/plain.txt"] });
  });

  test("should resolve a path relative to the home folder to the entry's repo path", () => {
    // Arrange
    const snapshot = snapshotWith({
      only: [".config/fixture/plain.txt"],
      home: MACOS_HOME,
      cwd: MACOS_HOME,
    });

    // Act
    const outcome = resolveOnly(snapshot, [PLAIN_SELECTED]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: ["dotfiles/linux/plain.txt"] });
  });

  test("should resolve a dir entry's folder to its repo path", () => {
    // Arrange
    const snapshot = snapshotWith({ only: ["~/.config/fixture/dir"] });

    // Act
    const outcome = resolveOnly(snapshot, [DIR_SELECTED]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: ["dotfiles/common/dir"] });
  });

  test("should resolve a dir entry's folder with a trailing slash", () => {
    // Arrange
    const snapshot = snapshotWith({ only: ["~/.config/fixture/dir/"] });

    // Act
    const outcome = resolveOnly(snapshot, [DIR_SELECTED]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: ["dotfiles/common/dir"] });
  });

  test("should resolve a file inside a dir entry's folder", () => {
    // Arrange
    const snapshot = snapshotWith({
      only: ["~/.config/fixture/dir/a/b.txt"],
    });

    // Act
    const outcome = resolveOnly(snapshot, [DIR_SELECTED]);

    // Assert
    expect(outcome).toEqual({
      ok: true,
      paths: ["dotfiles/common/dir/a/b.txt"],
    });
  });

  test("should refuse a sibling folder that only shares the prefix", () => {
    // Arrange
    const snapshot = snapshotWith({ only: ["~/.config/fixture/dir-other"] });

    // Act
    const outcome = resolveOnly(snapshot, [DIR_SELECTED]);

    // Assert
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected the sibling folder to be refused");
    }
    expect(outcome.plan.code).toBe(1);
    expect(outcome.plan.lines).toEqual([
      "ERROR: ~/.config/fixture/dir-other is not synced on this machine.",
    ]);
  });

  test("should resolve a json entry's OS label to its profile path", () => {
    // Arrange
    const selected = jsonSelected("base", "os", "profile");
    const snapshot = snapshotWith({ only: [JSON_OS_LABEL] });

    // Act
    const outcome = resolveOnly(snapshot, [selected]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: [JSON_PROFILE_PATH] });
  });

  test("should refuse a json entry's base label when the OS file exists", () => {
    // Arrange
    const selected = jsonSelected("base", "os", "profile");
    const snapshot = snapshotWith({ only: [JSON_BASE_LABEL] });

    // Act
    const outcome = resolveOnly(snapshot, [selected]);

    // Assert
    expect(outcome.ok).toBe(false);
  });

  test("should resolve a json entry's base label when only base and profile exist", () => {
    // Arrange
    const selected = jsonSelected("base", "profile");
    const snapshot = snapshotWith({ only: [JSON_BASE_LABEL] });

    // Act
    const outcome = resolveOnly(snapshot, [selected]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: [JSON_PROFILE_PATH] });
  });

  test("should refuse a whole entry's OS path when its primary path is a profile", () => {
    // Arrange
    const snapshot = snapshotWith({
      only: ["dotfiles/linux/plain.txt"],
    });

    // Act
    const outcome = resolveOnly(snapshot, [WHOLE_PROFILE_SELECTED]);

    // Assert
    expect(outcome.ok).toBe(false);
  });

  test("should resolve a json entry's OS label to itself without a profile layer", () => {
    // Arrange
    const selected = jsonSelected("base", "os");
    const snapshot = snapshotWith({ only: [JSON_OS_LABEL] });

    // Act
    const outcome = resolveOnly(snapshot, [selected]);

    // Assert
    expect(outcome).toEqual({ ok: true, paths: [JSON_OS_LABEL] });
  });
});

describe("onlySelected", () => {
  test("should select a file inside a picked dir entry", () => {
    // Arrange
    const only = ["dotfiles/common/dir"];

    // Act
    const selected = onlySelected("dotfiles/common/dir/a/b.txt", only);

    // Assert
    expect(selected).toBe(true);
  });

  test("should leave a sibling folder of a picked dir entry unselected", () => {
    // Arrange
    const only = ["dotfiles/common/dir"];

    // Act
    const selected = onlySelected("dotfiles/common/dirx/a", only);

    // Assert
    expect(selected).toBe(false);
  });

  test("should select a linked path of a picked file", () => {
    // Arrange
    const only = ["dotfiles/linux/plain.txt"];

    // Act
    const selected = onlySelected("dotfiles/linux/plain.txt.linked/x", only);

    // Assert
    expect(selected).toBe(true);
  });

  test("should leave a path sharing the picked file's prefix unselected", () => {
    // Arrange
    const only = ["dotfiles/linux/plain.txt"];

    // Act
    const selected = onlySelected("dotfiles/linux/plain.txt2", only);

    // Assert
    expect(selected).toBe(false);
  });

  test("should select every path when there are no picks", () => {
    // Arrange
    const only: readonly string[] = [];

    // Act
    const selected = onlySelected("dotfiles/linux/plain.txt", only);

    // Assert
    expect(selected).toBe(true);
  });
});
