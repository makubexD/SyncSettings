import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2 } from "../config/types.ts";
import { scopeFor } from "./pick.ts";
import type { Snapshot } from "./types.ts";

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {
    git: { description: "Git settings" },
    gnome: { description: "GNOME desktop", os: ["linux"] },
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

  test("should leave modules undefined without a profile", () => {
    // Arrange
    const snapshot = snapshotWith();

    // Act
    const scope = scopeFor(snapshot);

    // Assert
    expect(scope).toEqual({ os: "linux" });
    expect("modules" in scope).toBe(false);
  });
});
