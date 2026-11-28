import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import type { LayerName, SelectedEntry } from "../layers/select.ts";
import { formatLine } from "../status.ts";
import { planSettingMove } from "./setting-move.ts";
import type { SettingMove } from "./setting-move.ts";
import type { RunPlan, Snapshot } from "./types.ts";

const PROFILE: Profile = {
  name: "work1",
  modules: ["vscode", "git"],
  values: {},
  destinations: {},
  retired: false,
};

const VSCODE: ConfigV2Entry = {
  file: "vscode/settings.json",
  module: "vscode",
  merge: "json",
  localPath: "~/.config/Code/User/settings.json",
};

const GIT: ConfigV2Entry = {
  file: "git/.gitconfig.local",
  module: "git",
  merge: "whole",
  localPath: "~/.gitconfig.local",
};

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {
    vscode: { description: "VS Code" },
    git: { description: "Git settings" },
  },
  entries: [VSCODE, GIT],
};

const EMPTY_PLAN: RunPlan = {
  steps: [],
  finish: [],
  lines: [],
  summary: { kind: "none" },
  code: 0,
};

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const VS = "vscode/settings.json";
const GITCONFIG = "git/.gitconfig.local";
const GIT_TEXT = "[core]\n\teditor = vim\n";
const FOUR_SPACE_BASE = '{\n    "a": 1\n}\n';

/** The run's layer slots, with no file in any of them. */
function emptySelection(): readonly SelectedEntry[] {
  const selected = selectEntries(
    CONFIG,
    { os: "linux", profile: PROFILE, machine: "wk1-laptop" },
    new Set(),
  );
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  return selected.value;
}

function pathOf(file: string, layer: LayerName): string {
  const entry = emptySelection().find((each) => each.entry.file === file);
  const slot = entry?.slots.find((each) => each.name === layer);
  if (slot === undefined) {
    throw new Error(`no ${layer} slot for ${file}`);
  }
  return slot.repoPath;
}

type Layers = Partial<Record<LayerName, string>>;

interface Fixture {
  readonly snapshot: Snapshot;
  readonly selected: readonly SelectedEntry[];
}

function fixture(files: Readonly<Record<string, Layers>>): Fixture {
  const repoFiles = new Map<string, Uint8Array>();
  for (const [file, layers] of Object.entries(files)) {
    for (const [layer, text] of Object.entries(layers)) {
      repoFiles.set(pathOf(file, layer as LayerName), ENCODER.encode(text));
    }
  }
  const selected = selectEntries(
    CONFIG,
    { os: "linux", profile: PROFILE, machine: "wk1-laptop" },
    new Set(repoFiles.keys()),
  );
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  const snapshot: Snapshot = {
    config: CONFIG,
    os: "linux",
    profile: PROFILE,
    machine: "wk1-laptop",
    home: "/home/user",
    cwd: "/home/user",
    repoFiles,
    localFiles: new Map(),
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
  };
  return { snapshot, selected: selected.value };
}

function move(
  files: Readonly<Record<string, Layers>>,
  target: string,
  key: string | undefined,
  to: LayerName,
): SettingMove {
  const { snapshot, selected } = fixture(files);
  const result = planSettingMove(
    EMPTY_PLAN,
    snapshot,
    selected,
    target,
    key,
    to,
  );
  if (!result.ok) {
    throw new Error(result.error.line);
  }
  if ("already" in result.value) {
    throw new Error(`already in ${result.value.already}`);
  }
  return result.value;
}

/** The text the plan writes to `file`'s `layer`, `null` for a removal,
 * `undefined` when the plan leaves it alone. */
function written(
  plan: RunPlan,
  file: string,
  layer: LayerName,
): string | null | undefined {
  const path = pathOf(file, layer);
  for (const step of plan.steps) {
    for (const { action } of step.actions) {
      if (action.kind === "writeRepo" && action.path === path) {
        return DECODER.decode(action.bytes);
      }
      if (action.kind === "removeRepo" && action.path === path) {
        return null;
      }
    }
  }
  return undefined;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("planSettingMove", () => {
  test("should write a wider key into the target and remove it from the source", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ "editor.fontSize": 14, "files.autoSave": "off" }),
        profile: json({ "editor.fontSize": 15 }),
      },
    };

    // Act
    const moved = move(files, VS, "editor.fontSize", "base");

    // Assert
    expect(moved.source).toBe("profile");
    expect(moved.text).toBe("Move vscode settings.json editor.fontSize: 15");
    expect(written(moved.plan, VS, "base")).toBe(
      json({ "editor.fontSize": 15, "files.autoSave": "off" }),
    );
    expect(written(moved.plan, VS, "profile")).toBe("{}\n");
    expect(moved.plan.lines).toEqual([
      formatLine("MODIFIED", "dotfiles/common/vscode/settings.json"),
      formatLine("MODIFIED", "profiles/work1/vscode/settings.json"),
    ]);
  });

  test("should keep the key in the source when a layer between sets it", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ "editor.fontSize": 14 }),
        os: json({ "editor.fontSize": 16 }),
        profile: json({ "editor.fontSize": 15 }),
      },
    };

    // Act
    const moved = move(files, VS, "editor.fontSize", "base");

    // Assert
    expect(written(moved.plan, VS, "base")).toBe(
      json({ "editor.fontSize": 15 }),
    );
    expect(written(moved.plan, VS, "profile")).toBeUndefined();
    expect(written(moved.plan, VS, "os")).toBeUndefined();
  });

  test("should write a narrower key into the target and leave the source", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ "editor.fontSize": 14, "window.zoomLevel": 1 }),
        profile: json({ "editor.fontSize": 15 }),
      },
    };

    // Act
    const moved = move(files, VS, "window.zoomLevel", "profile");

    // Assert
    expect(moved.source).toBe("base");
    expect(written(moved.plan, VS, "base")).toBeUndefined();
    expect(written(moved.plan, VS, "profile")).toBe(
      json({ "editor.fontSize": 15, "window.zoomLevel": 1 }),
    );
    expect(moved.plan.lines).toEqual([
      formatLine("MODIFIED", "profiles/work1/vscode/settings.json"),
    ]);
  });

  test("should add the items the target lacks and empty the source", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ allow: ["a", "b"] }),
        profile: json({ allow: ["b", "c"] }),
      },
    };

    // Act
    const moved = move(files, VS, "allow[]", "base");

    // Assert
    expect(moved.text).toBe("Move vscode settings.json allow[]: 2 item(s)");
    expect(written(moved.plan, VS, "base")).toBe(
      json({ allow: ["a", "b", "c"] }),
    );
    expect(written(moved.plan, VS, "profile")).toBe(json({ allow: [] }));
  });

  test("should move a whole file wider and remove the source", () => {
    // Arrange
    const files = { [GITCONFIG]: { os: GIT_TEXT } };

    // Act
    const moved = move(files, GITCONFIG, undefined, "base");

    // Assert
    expect(moved.source).toBe("os");
    expect(moved.text).toBe("Move git .gitconfig.local (whole file)");
    expect(written(moved.plan, GITCONFIG, "base")).toBe(GIT_TEXT);
    expect(written(moved.plan, GITCONFIG, "os")).toBeNull();
    expect(moved.plan.lines).toEqual([
      formatLine("ADDED", "dotfiles/common/git/.gitconfig.local"),
      formatLine("REMOVED", "dotfiles/linux/git/.gitconfig.local"),
    ]);
  });

  test("should keep the source file when a layer between holds the file", () => {
    // Arrange
    const files = {
      [GITCONFIG]: { os: "[core]\n\teditor = nano\n", profile: GIT_TEXT },
    };

    // Act
    const moved = move(files, GITCONFIG, undefined, "base");

    // Assert
    expect(moved.source).toBe("profile");
    expect(written(moved.plan, GITCONFIG, "base")).toBe(GIT_TEXT);
    expect(written(moved.plan, GITCONFIG, "profile")).toBeUndefined();
  });

  test("should pick the narrowest of three layers that set the key", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ "editor.fontSize": 14 }),
        os: json({ "editor.fontSize": 16 }),
        profile: json({ "editor.fontSize": 15 }),
      },
    };

    // Act
    const moved = move(files, VS, "editor.fontSize", "machine");

    // Assert
    expect(moved.source).toBe("profile");
    expect(written(moved.plan, VS, "machine")).toBe(
      json({ "editor.fontSize": 15 }),
    );
  });

  test("should answer already when the target is the source", () => {
    // Arrange
    const { snapshot, selected } = fixture({
      [VS]: {
        base: json({ "editor.fontSize": 14 }),
        profile: json({ "editor.fontSize": 15 }),
      },
    });

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      VS,
      "editor.fontSize",
      "profile",
    );

    // Assert
    expect(result).toEqual({ ok: true, value: { already: "profile" } });
  });

  test("should move a key holding a dot as one key", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ editor: { tabSize: 2 } }),
        profile: json({ "editor.fontSize": 15 }),
      },
    };

    // Act
    const moved = move(files, VS, "editor.fontSize", "base");

    // Assert
    expect(written(moved.plan, VS, "base")).toBe(
      json({ editor: { tabSize: 2 }, "editor.fontSize": 15 }),
    );
  });

  test("should remove an object the move leaves empty", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ "files.autoSave": "off" }),
        profile: json({ "[python]": { "editor.formatOnSave": true } }),
      },
    };

    // Act
    const moved = move(files, VS, "[python].editor.formatOnSave", "base");

    // Assert
    expect(written(moved.plan, VS, "profile")).toBe("{}\n");
    expect(written(moved.plan, VS, "base")).toBe(
      json({
        "files.autoSave": "off",
        "[python]": { "editor.formatOnSave": true },
      }),
    );
  });

  test("should refuse a key no layer sets", () => {
    // Arrange
    const { snapshot, selected } = fixture({
      [VS]: { base: json({ "editor.fontSize": 14 }) },
    });

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      VS,
      "editor.tabSize",
      "base",
    );

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        line: "ERROR: no layer sets editor.tabSize in vscode/settings.json",
        code: 1,
      },
    });
  });

  test("should refuse a whole file no layer holds", () => {
    // Arrange
    const { snapshot, selected } = fixture({});

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      GITCONFIG,
      undefined,
      "base",
    );

    // Assert
    expect(result).toEqual({
      ok: false,
      error: { line: "ERROR: no layer holds git/.gitconfig.local", code: 1 },
    });
  });

  test("should leave a narrower move's source byte for byte when its layout differs", () => {
    // Arrange
    const files = { [VS]: { base: FOUR_SPACE_BASE } };

    // Act
    const moved = move(files, VS, "a", "profile");

    // Assert
    expect(written(moved.plan, VS, "base")).toBeUndefined();
    expect(written(moved.plan, VS, "profile")).toBe(json({ a: 1 }));
  });

  test("should copy a whole file narrower and keep the source", () => {
    // Arrange
    const files = { [GITCONFIG]: { os: GIT_TEXT } };

    // Act
    const moved = move(files, GITCONFIG, undefined, "machine");

    // Assert
    expect(written(moved.plan, GITCONFIG, "machine")).toBe(GIT_TEXT);
    expect(written(moved.plan, GITCONFIG, "os")).toBeUndefined();
  });

  test("should take every item out of the source on a wider array move", () => {
    // Arrange
    const files = {
      [VS]: {
        base: json({ allow: ["a", "b"] }),
        profile: json({ allow: ["a"] }),
      },
    };

    // Act
    const moved = move(files, VS, "allow[]", "base");

    // Assert
    expect(written(moved.plan, VS, "base")).toBeUndefined();
    expect(written(moved.plan, VS, "profile")).toBe(json({ allow: [] }));
  });

  test("should answer already when a narrower move has no item to carry", () => {
    // Arrange
    const { snapshot, selected } = fixture({
      [VS]: { base: json({ allow: ["a"] }), profile: json({ allow: [] }) },
    });

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      VS,
      "allow[]",
      "machine",
    );

    // Assert
    expect(result).toEqual({ ok: true, value: { already: "machine" } });
  });

  test.each([
    [
      VS,
      undefined,
      "ERROR: vscode/settings.json is a json entry; name a key",
      2,
    ],
    [
      GITCONFIG,
      "a",
      "ERROR: git/.gitconfig.local is not a json entry; it moves as a whole file, with no key",
      2,
    ],
    [
      "shell/.aliases",
      undefined,
      "ERROR: no entry shell/.aliases in sync-config.json",
      2,
    ],
  ])("should refuse %s with key %s", (target, key, line, code) => {
    // Arrange
    const { snapshot, selected } = fixture({
      [VS]: { base: json({ a: 1 }) },
      [GITCONFIG]: { os: GIT_TEXT },
    });

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      target,
      key,
      "base",
    );

    // Assert
    expect(result).toEqual({ ok: false, error: { line, code } });
  });

  test("should refuse a layer that isn't valid JSON", () => {
    // Arrange
    const { snapshot, selected } = fixture({
      [VS]: { base: json({ a: 1 }), profile: "{ not json" },
    });

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      VS,
      "a",
      "machine",
    );

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        line: "ERROR: not valid JSON: profiles/work1/vscode/settings.json",
        code: 1,
      },
    });
  });

  test("should refuse a move that would change the merged result", () => {
    // Arrange: the profile's array hides the base's object, so a copy of
    // deep.x in the machine layer would bring the object back.
    const { snapshot, selected } = fixture({
      [VS]: {
        base: json({ deep: { x: 1 } }),
        profile: json({ deep: [1] }),
      },
    });

    // Act
    const result = planSettingMove(
      EMPTY_PLAN,
      snapshot,
      selected,
      VS,
      "deep.x",
      "machine",
    );

    // Assert
    expect(result).toEqual({
      ok: false,
      error: {
        line: "moving deep.x to machine would change the merged result",
        code: 1,
      },
    });
  });
});
