import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { jsonEqual } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import type { LayerName } from "../layers/select.ts";
import { mergeJsonValues, parseJsonBytes } from "../merge/json.ts";
import type { JsonLayer } from "../merge/json.ts";
import { changeLines, changeMoveSources } from "./changes.ts";
import { applyMove, moveJsonChange, moveWholeFile } from "./move.ts";
import type { Action, LocalEntry, RunPlan, Snapshot } from "./types.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const EOL = "\n";
const WRITE_ITEM: JsonValue = { kind: "string", value: "write" };

function slot(name: LayerName, text: string | undefined): JsonLayer {
  return {
    name,
    repoPath: `dotfiles/${name}/settings.json`,
    bytes: text === undefined ? undefined : ENCODER.encode(text),
  };
}

function textOf(layer: JsonLayer | undefined): string | undefined {
  return layer?.bytes === undefined ? undefined : DECODER.decode(layer.bytes);
}

function layerNamed(
  slots: readonly JsonLayer[],
  name: LayerName,
): JsonLayer | undefined {
  return slots.find((layer) => layer.name === name);
}

/** The merge of the slots that hold a file, which a move must not change. */
function mergedValues(slots: readonly JsonLayer[]): JsonValue {
  const values = slots
    .map((layer) =>
      layer.bytes === undefined ? undefined : parseJsonBytes(layer.bytes),
    )
    .filter((value): value is JsonValue => value !== undefined);
  return mergeJsonValues(values);
}

function expectSameMerge(
  before: readonly JsonLayer[],
  after: readonly JsonLayer[],
): void {
  expect(jsonEqual(mergedValues(before), mergedValues(after))).toBe(true);
}

describe("moveJsonChange", () => {
  test("key narrowed to profile: both layers hold it and the profile overrides", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("os", undefined),
      slot("profile", '{"editor.fontSize": 15}'),
      slot("machine", undefined),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      ["editor.fontSize"],
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    // The source layer's bytes stay as they are.
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{"editor.fontSize": 14}',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{\n  "editor.fontSize": 15\n}\n',
    );
  });

  test("key widened to base: base holds it and profile no longer does", () => {
    const before = [
      slot("base", '{"editor.tabSize": 2}'),
      slot("os", undefined),
      slot("profile", '{"editor.fontSize": 14}'),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      ["editor.fontSize"],
      "key",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "editor.tabSize": 2,\n  "editor.fontSize": 14\n}\n',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe("{}\n");
  });

  test("key widened to base with the os layer setting it: profile keeps it", () => {
    const before = [
      slot("base", '{"editor.tabSize": 2}'),
      slot("os", '{"editor.fontSize": 13}'),
      slot("profile", '{"editor.fontSize": 14}'),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      ["editor.fontSize"],
      "key",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "editor.tabSize": 2,\n  "editor.fontSize": 14\n}\n',
    );
    // The intermediate os layer sets the path, so the profile keeps it.
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{"editor.fontSize": 14}',
    );
  });

  test("array item widened from profile to base", () => {
    const before = [
      slot("base", '{"permissions": {"allow": ["read"]}}'),
      slot("os", undefined),
      slot("profile", '{"permissions": {"allow": ["write", "edit"]}}'),
    ];
    const result = moveJsonChange(
      before,
      "permissions.allow[]",
      ["permissions", "allow"],
      "item",
      "profile",
      "base",
      EOL,
      WRITE_ITEM,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "read",\n      "write"\n    ]\n  }\n}\n',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "edit"\n    ]\n  }\n}\n',
    );
  });

  test("an item move without the item is an error", () => {
    const before = [
      slot("base", '{"allow": ["read"]}'),
      slot("profile", '{"allow": ["write"]}'),
    ];
    const result = moveJsonChange(
      before,
      "allow[]",
      ["allow"],
      "item",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(false);
  });

  test("an object key widened to base keeps the keys only base held", () => {
    const before = [
      slot("base", '{"editor": {"tabSize": 2, "wrap": true}}'),
      slot("os", undefined),
      slot("profile", '{"editor": {"tabSize": 4}}'),
    ];
    const result = moveJsonChange(
      before,
      "editor",
      ["editor"],
      "key",
      "profile",
      "base",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{\n  "editor": {\n    "tabSize": 4,\n    "wrap": true\n  }\n}\n',
    );
  });

  test("a target slot with no file yet gets one", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", undefined),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      ["editor.fontSize"],
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{"editor.fontSize": 14}',
    );
    expect(textOf(layerNamed(result.value, "profile"))).toBe(
      '{\n  "editor.fontSize": 14\n}\n',
    );
  });

  test("a nested key whose name has a dot moves to machine", () => {
    const before = [
      slot("base", '{"[python]": {"editor.formatOnSave": true}}'),
      slot("os", undefined),
      slot("profile", undefined),
      slot("machine", undefined),
    ];
    const result = moveJsonChange(
      before,
      "[python].editor.formatOnSave",
      ["[python]", "editor.formatOnSave"],
      "key",
      "base",
      "machine",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "machine"))).toBe(
      '{\n  "[python]": {\n    "editor.formatOnSave": true\n  }\n}\n',
    );
    // Narrower: base is left as the repo holds it.
    expect(textOf(layerNamed(result.value, "base"))).toBe(
      '{"[python]": {"editor.formatOnSave": true}}',
    );
  });

  test("the same layer leaves the slots unchanged", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", '{"editor.fontSize": 15}'),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      ["editor.fontSize"],
      "key",
      "profile",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toBe(before);
    expectSameMerge(before, result.value);
  });

  test("a path the source doesn't hold is an error", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", undefined),
    ];
    const result = moveJsonChange(
      before,
      "editor.tabSize",
      ["editor.tabSize"],
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("editor.tabSize");
  });

  test("a slot that isn't valid JSON is an error", () => {
    const before = [
      slot("base", '{"editor.fontSize": 14}'),
      slot("profile", "{oops"),
    ];
    const result = moveJsonChange(
      before,
      "editor.fontSize",
      ["editor.fontSize"],
      "key",
      "base",
      "profile",
      EOL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("not valid JSON: dotfiles/profile/settings.json");
  });
});

describe("moveWholeFile", () => {
  test("the whole file moves from base to machine", () => {
    const before = [slot("base", '{"a": 1}'), slot("machine", undefined)];
    const result = moveWholeFile(before, "base", "machine");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(layerNamed(result.value, "base")?.bytes).toBeUndefined();
    // A whole file moves as its bytes are, without a rewrite.
    expect(textOf(layerNamed(result.value, "machine"))).toBe('{"a": 1}');
  });

  test("a wider move keeps the source when a layer between has the file", () => {
    const before = [
      slot("base", undefined),
      slot("os", '{"a": 2}'),
      slot("machine", '{"a": 3}'),
    ];
    const result = moveWholeFile(before, "machine", "base");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expectSameMerge(before, result.value);
    expect(textOf(layerNamed(result.value, "machine"))).toBe('{"a": 3}');
  });

  test("a narrower move past a layer that has the file is an error", () => {
    const before = [
      slot("base", '{"a": 1}'),
      slot("os", '{"a": 2}'),
      slot("machine", undefined),
    ];
    const result = moveWholeFile(before, "base", "machine");
    expect(result.ok).toBe(false);
  });
});

const HOME = "/home/user";

const PROFILE_NAME = "work-1";

const MACHINE_NAME = "work-1";

const MODE = 0o644;

const BASE_JSON = "dotfiles/common/parity/settings.json";

const OS_JSON = "dotfiles/linux/parity/settings.json";

const PROFILE_JSON = `profiles/${PROFILE_NAME}/parity/settings.json`;

const BASE_BASHRC = "dotfiles/common/shell/bashrc";

const JSON_ENTRY: ConfigV2Entry = {
  file: "parity/settings.json",
  module: "parity",
  merge: "json",
  localPath: "~/.config/parity/settings.json",
  description: "Parity JSON settings",
};

const BASHRC_ENTRY: ConfigV2Entry = {
  file: "shell/bashrc",
  module: "shell",
  merge: "whole",
  localPath: "~/.config/parity/bashrc",
  description: "Shell start-up file",
};

const PROFILE: Profile = {
  name: PROFILE_NAME,
  modules: ["parity", "shell"],
  values: {},
  destinations: {},
  retired: false,
};

interface Fixture {
  readonly config: ConfigV2;
  readonly repo?: Readonly<Record<string, string>>;
  readonly local?: Readonly<Record<string, string>>;
  readonly profile?: Profile;
  readonly machine?: string;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function configOf(entries: readonly ConfigV2Entry[]): ConfigV2 {
  return {
    schemaVersion: 2,
    modules: {
      parity: { description: "Parity case files" },
      shell: { description: "Shell start-up files" },
    },
    entries,
  };
}

function snapshotOf(fixture: Fixture): Snapshot {
  const repoFiles = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(fixture.repo ?? {})) {
    repoFiles.set(path, bytes(text));
  }
  const localFiles = new Map<string, LocalEntry>();
  for (const [path, text] of Object.entries(fixture.local ?? {})) {
    localFiles.set(path, {
      kind: "file",
      path,
      bytes: bytes(text),
      mode: MODE,
    });
  }
  return {
    config: fixture.config,
    os: "linux",
    home: HOME,
    cwd: HOME,
    repoFiles,
    localFiles,
    localDirs: new Set(),
    values: {},
    env: {},
    only: [],
    ...(fixture.profile !== undefined ? { profile: fixture.profile } : {}),
    ...(fixture.machine !== undefined ? { machine: fixture.machine } : {}),
  };
}

function planOf(...steps: readonly (readonly Action[])[]): RunPlan {
  return {
    steps: steps.map((actions, index) => ({
      label: `step ${index}`,
      line: index,
      counted: true,
      actions: actions.map((action) => ({ action, failure: "failed" })),
    })),
    finish: [],
    lines: [],
    summary: { kind: "none" },
    code: 0,
  };
}

function writeRepo(path: string, text: string): Action {
  return { kind: "writeRepo", path, bytes: bytes(text) };
}

describe("changeMoveSources", () => {
  test("names each json key line's layer, path and action", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0}' },
    });
    const plan = planOf([
      writeRepo(BASE_JSON, '{"alpha":1,"bravo":"new value"}'),
    ]);

    const sources = changeMoveSources(plan, snapshot);

    expect(sources).toHaveLength(changeLines(plan, snapshot).length);
    expect(sources.map((source) => source.kind)).toEqual(["key", "key"]);
    expect(sources.map((source) => source.path)).toEqual(["alpha", "bravo"]);
    expect(sources[0]?.layer).toBe("base");
    expect(sources[0]?.repoPath).toBe(BASE_JSON);
    expect(sources[0]?.entry.entry.module).toBe("parity");
  });

  test("names an added array item line with its item", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: {
        [BASE_JSON]: '{"baseKey":1,"delta":["x"]}',
        [OS_JSON]: '{"osKey":"linux"}',
      },
      profile: PROFILE,
    });
    const plan = planOf([
      writeRepo(OS_JSON, '{"osKey":"linux","delta":["new item"]}'),
    ]);

    const sources = changeMoveSources(plan, snapshot);

    expect(sources).toHaveLength(changeLines(plan, snapshot).length);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("item");
    expect(sources[0]?.path).toBe("delta[]");
    expect(sources[0]?.layer).toBe("os");
    expect(sources[0]?.item).toEqual({ kind: "string", value: "new item" });
  });

  test("names a whole file line as a whole move", () => {
    const snapshot = snapshotOf({
      config: configOf([BASHRC_ENTRY]),
      repo: { [BASE_BASHRC]: "one\n" },
    });
    const plan = planOf([writeRepo(BASE_BASHRC, "two\n")]);

    const sources = changeMoveSources(plan, snapshot);

    expect(sources).toHaveLength(changeLines(plan, snapshot).length);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("whole");
    expect(sources[0]?.layer).toBe("base");
    expect(sources[0]?.repoPath).toBe(BASE_BASHRC);
    expect(sources[0]?.path).toBeUndefined();
  });

  test("keeps the block's order across files", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY, BASHRC_ENTRY]),
      repo: {
        [BASE_JSON]: '{"list":["old"]}',
        [BASE_BASHRC]: "one\n",
      },
    });
    const plan = planOf(
      [writeRepo(BASE_JSON, '{"list":["new"]}')],
      [writeRepo(BASE_BASHRC, "two\n")],
    );

    const sources = changeMoveSources(plan, snapshot);

    expect(sources).toHaveLength(changeLines(plan, snapshot).length);
    expect(sources.map((source) => source.kind)).toEqual([
      "item",
      "item",
      "whole",
    ]);
  });

  test("names an item added to an existing array with its item", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"list":["old"]}' },
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"list":["old","new"]}')]);

    const sources = changeMoveSources(plan, snapshot);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("item");
    expect(sources[0]?.path).toBe("list[]");
    expect(sources[0]?.item).toEqual({ kind: "string", value: "new" });
  });
});

describe("applyMove", () => {
  test("moves a base key to the profile and lists it there", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"editor.fontSize":14}' },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"editor.fontSize":15}')]);

    const moved = applyMove(plan, snapshot, 1, "profile");

    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    const lines = changeLines(moved.value, snapshot);
    expect(lines.filter((line) => line.layer === "profile")).toEqual([
      {
        layer: "profile",
        kind: "+",
        module: "parity",
        file: "settings.json",
        what: "editor.fontSize: 15",
      },
    ]);
    // Base is left as the repo holds it: other machines don't receive it.
    expect(lines.some((line) => line.layer === "base")).toBe(false);
  });

  test("a narrowed new key leaves base without it", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0}' },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"alpha":1,"bravo":2}')]);

    const moved = applyMove(plan, snapshot, 2, "profile");

    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    expect(
      changeLines(moved.value, snapshot).map((line) => [line.layer, line.what]),
    ).toEqual([
      ["base", "alpha: 0 -> 1"],
      ["profile", "bravo: 2"],
    ]);
  });

  test("a removed setting can't move", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0}' },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(BASE_JSON, "{}")]);

    expect(applyMove(plan, snapshot, 1, "profile").ok).toBe(false);
  });

  test("moves a profile key to base and removes it from the profile", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: {
        [BASE_JSON]: '{"editor.tabSize":2}',
        [PROFILE_JSON]: '{"editor.fontSize":14}',
      },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(PROFILE_JSON, '{"editor.fontSize":15}')]);

    const moved = applyMove(plan, snapshot, 1, "base");

    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    const lines = changeLines(moved.value, snapshot);
    expect(lines.filter((line) => line.layer === "profile")).toEqual([
      {
        layer: "profile",
        kind: "-",
        module: "parity",
        file: "settings.json",
        what: "editor.fontSize: 14",
      },
    ]);
    expect(lines.some((line) => line.layer === "base")).toBe(true);
  });

  test("moves a whole file from base to the machine layer", () => {
    const snapshot = snapshotOf({
      config: configOf([BASHRC_ENTRY]),
      repo: { [BASE_BASHRC]: "one\n" },
      machine: MACHINE_NAME,
    });
    const plan = planOf([writeRepo(BASE_BASHRC, "two\n")]);

    const moved = applyMove(plan, snapshot, 1, "machine");

    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    // Base stays as the repo holds it, so other machines keep the old file.
    expect(changeLines(moved.value, snapshot)).toEqual([
      {
        layer: "machine",
        kind: "+",
        module: "shell",
        file: "bashrc",
        what: "new file, 1 line(s)",
      },
    ]);
  });

  test("an out-of-range line is an error", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0}' },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"alpha":1}')]);

    expect(applyMove(plan, snapshot, 0, "profile").ok).toBe(false);
    expect(applyMove(plan, snapshot, 2, "profile").ok).toBe(false);
  });

  test("a layer the entry has no slot for is an error", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0}' },
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"alpha":1}')]);

    expect(applyMove(plan, snapshot, 1, "profile").ok).toBe(false);
  });

  test("the same layer leaves the plan as it is", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0}' },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"alpha":1}')]);

    const moved = applyMove(plan, snapshot, 1, "base");

    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    expect(moved.value).toBe(plan);
  });
});
