import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import type { SelectedEntry } from "../layers/select.ts";
import type { MachineRecord } from "../machine/record.ts";
import { resolveOnly, scopeFor } from "./pick.ts";
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
});
