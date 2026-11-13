import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { changeLines, importChangeLines } from "./changes.ts";
import type {
  Action,
  ChangeLine,
  LocalEntry,
  RunPlan,
  Snapshot,
} from "./types.ts";

const HOME = "/home/user";

const PROFILE_NAME = "work-1";

const MODE = 0o644;

const BASE_JSON = "dotfiles/common/parity/settings.json";

const OS_JSON = "dotfiles/linux/parity/settings.json";

const PROFILE_JSON = `profiles/${PROFILE_NAME}/parity/settings.json`;

const LOCAL_JSON = "/home/user/.config/parity/settings.json";

const BASE_BASHRC = "dotfiles/common/shell/bashrc";

const BASE_CLAUDE = "dotfiles/common/claude/CLAUDE.md";

const PROFILE_CLAUDE = `profiles/${PROFILE_NAME}/claude/CLAUDE.md`;

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

const CLAUDE_ENTRY: ConfigV2Entry = {
  file: "claude/CLAUDE.md",
  module: "claude",
  merge: "import",
  localPath: "~/.config/claude/CLAUDE.md",
  importName: "CLAUDE.{layer}.md",
  description: "Claude notes with side files",
};

const PROFILE: Profile = {
  name: PROFILE_NAME,
  modules: ["parity", "shell", "claude"],
  values: {},
  destinations: {},
  retired: false,
};

interface Fixture {
  readonly config: ConfigV2;
  readonly repo?: Readonly<Record<string, string>>;
  readonly local?: Readonly<Record<string, string>>;
  readonly profile?: Profile;
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
      claude: { description: "Claude notes" },
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

function writeLocal(path: string, text: string): Action {
  return { kind: "writeLocal", path, bytes: bytes(text) };
}

function removeRepo(path: string): Action {
  return { kind: "removeRepo", path };
}

function layersOf(lines: readonly ChangeLine[]): readonly string[] {
  return lines.map((line) => line.layer);
}

describe("changeLines", () => {
  test("prints a changed, an added and a removed key", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"alpha":0,"charlie":"remove me"}' },
    });
    const plan = planOf([
      writeRepo(BASE_JSON, '{"alpha":1,"bravo":"new value"}'),
    ]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "M",
        module: "parity",
        file: "settings.json",
        what: "alpha: 0 -> 1",
      },
      {
        layer: "base",
        kind: "+",
        module: "parity",
        file: "settings.json",
        what: 'bravo: "new value"',
      },
      {
        layer: "base",
        kind: "-",
        module: "parity",
        file: "settings.json",
        what: 'charlie: "remove me"',
      },
    ]);
  });

  test("joins nested keys with a dot", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"editor":{"fontSize":14,"tabSize":2}}' },
    });
    const plan = planOf([
      writeRepo(BASE_JSON, '{"editor":{"fontSize":15,"tabSize":2}}'),
    ]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "M",
        module: "parity",
        file: "settings.json",
        what: "editor.fontSize: 14 -> 15",
      },
    ]);
  });

  test("prints a removed and an added array item with - before +", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"allow":["keep","old"]}' },
    });
    const plan = planOf([
      writeRepo(BASE_JSON, '{"allow":["keep","new"]}'),
    ]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "-",
        module: "parity",
        file: "settings.json",
        what: 'allow[]: "old"',
      },
      {
        layer: "base",
        kind: "+",
        module: "parity",
        file: "settings.json",
        what: 'allow[]: "new"',
      },
    ]);
  });

  test("does not cut a value of exactly 60 characters", () => {
    const value = "x".repeat(58);
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: "{}" },
    });
    const plan = planOf([writeRepo(BASE_JSON, `{"key":"${value}"}`)]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "+",
        module: "parity",
        file: "settings.json",
        what: `key: "${value}"`,
      },
    ]);
  });

  test("cuts a value of 61 characters to 57 and three dots", () => {
    const value = "x".repeat(59);
    const cut = `"${"x".repeat(56)}...`;
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: "{}" },
    });
    const plan = planOf([writeRepo(BASE_JSON, `{"key":"${value}"}`)]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "+",
        module: "parity",
        file: "settings.json",
        what: `key: ${cut}`,
      },
    ]);
  });

  test("prints a sanitized value as its placeholder", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: { [BASE_JSON]: '{"email":"old@example.com"}' },
    });
    const plan = planOf([writeRepo(BASE_JSON, '{"email":"<YOUR_EMAIL>"}')]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "M",
        module: "parity",
        file: "settings.json",
        what: 'email: "old@example.com" -> "<YOUR_EMAIL>"',
      },
    ]);
  });

  test("gives base, OS and profile writes their own layer", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: {
        [BASE_JSON]: '{"baseKey":1}',
        [OS_JSON]: '{"osKey":"a"}',
        [PROFILE_JSON]: '{"profileKey":true}',
      },
      profile: PROFILE,
    });
    const plan = planOf([
      writeRepo(BASE_JSON, '{"baseKey":2}'),
      writeRepo(OS_JSON, '{"osKey":"b"}'),
      writeRepo(PROFILE_JSON, '{"profileKey":false}'),
    ]);

    expect(layersOf(changeLines(plan, snapshot))).toEqual([
      "base",
      "os",
      "profile",
    ]);
  });

  test("describes a changed whole file by its line diff", () => {
    const snapshot = snapshotOf({
      config: configOf([BASHRC_ENTRY]),
      repo: { [BASE_BASHRC]: "one\ntwo\nthree\n" },
    });
    const plan = planOf([
      writeRepo(BASE_BASHRC, "four\nfive\nsix\n"),
    ]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "M",
        module: "shell",
        file: "bashrc",
        what: "3 line(s) changed",
      },
    ]);
  });

  test("describes a file new to its layer as a new file", () => {
    const snapshot = snapshotOf({ config: configOf([BASHRC_ENTRY]) });
    const plan = planOf([writeRepo(BASE_BASHRC, "one\ntwo\n")]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "+",
        module: "shell",
        file: "bashrc",
        what: "new file, 2 line(s)",
      },
    ]);
  });

  test("labels an import side file with its resolved importName", () => {
    const snapshot = snapshotOf({
      config: configOf([CLAUDE_ENTRY]),
      repo: {
        [BASE_CLAUDE]: "base\n",
        [PROFILE_CLAUDE]: "old\n",
      },
      profile: PROFILE,
    });
    const plan = planOf([writeRepo(PROFILE_CLAUDE, "new\n")]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "profile",
        kind: "M",
        module: "claude",
        file: "CLAUDE.work-1.md",
        what: "1 line(s) changed",
      },
    ]);
  });

  test("keeps entry order across files and sorts within one", () => {
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
    const lines = changeLines(plan, snapshot);

    expect(lines.map((line) => `${line.kind} ${line.file}`)).toEqual([
      "- settings.json",
      "+ settings.json",
      "M bashrc",
    ]);
  });

  test("leaves out an action no selected entry layer owns", () => {
    const snapshot = snapshotOf({ config: configOf([JSON_ENTRY]) });
    const plan = planOf([writeRepo("dotfiles/common/orphan/file", "text\n")]);

    expect(changeLines(plan, snapshot)).toEqual([]);
  });

  test("describes a removed dir file by its old line count", () => {
    const dirEntry: ConfigV2Entry = {
      file: "notes",
      module: "shell",
      merge: "dir",
      localPath: "~/.config/parity/notes",
      description: "Notes folder",
    };
    const snapshot = snapshotOf({
      config: configOf([dirEntry]),
      repo: { "dotfiles/common/notes/a.txt": "one\ntwo\n" },
    });
    const plan = planOf([removeRepo("dotfiles/common/notes/a.txt")]);

    expect(changeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "-",
        module: "shell",
        file: "notes/a.txt",
        what: "2 line(s) changed",
      },
    ]);
  });
});

describe("importChangeLines", () => {
  test("gives a changed key the latest layer that sets it", () => {
    const snapshot = snapshotOf({
      config: configOf([JSON_ENTRY]),
      repo: {
        [BASE_JSON]: '{"baseKey":0}',
        [PROFILE_JSON]: '{"profileKey":"new"}',
      },
      local: {
        [LOCAL_JSON]: '{"baseKey":0,"profileKey":"old","gone":true}',
      },
      profile: PROFILE,
    });
    const plan = planOf([
      writeLocal(LOCAL_JSON, '{"baseKey":0,"profileKey":"new"}'),
    ]);

    expect(importChangeLines(plan, snapshot)).toEqual([
      {
        layer: "profile",
        kind: "-",
        module: "parity",
        file: "settings.json",
        what: "gone: true",
      },
      {
        layer: "profile",
        kind: "M",
        module: "parity",
        file: "settings.json",
        what: 'profileKey: "old" -> "new"',
      },
    ]);
  });

  test("labels an import side file with that layer's name", () => {
    const snapshot = snapshotOf({
      config: configOf([CLAUDE_ENTRY]),
      repo: {
        [BASE_CLAUDE]: "base\n",
        [PROFILE_CLAUDE]: "new\n",
      },
      local: {
        "/home/user/.config/claude/CLAUDE.md": "base\n",
        "/home/user/.config/claude/CLAUDE.work-1.md": "old\n",
      },
      profile: PROFILE,
    });
    const plan = planOf([
      writeLocal("/home/user/.config/claude/CLAUDE.work-1.md", "new\n"),
    ]);

    expect(importChangeLines(plan, snapshot)).toEqual([
      {
        layer: "profile",
        kind: "M",
        module: "claude",
        file: "CLAUDE.work-1.md",
        what: "1 line(s) changed",
      },
    ]);
  });

  test("describes a whole file new to the machine", () => {
    const snapshot = snapshotOf({
      config: configOf([BASHRC_ENTRY]),
      repo: { [BASE_BASHRC]: "one\ntwo\n" },
    });
    const plan = planOf([
      writeLocal("/home/user/.config/parity/bashrc", "one\ntwo\n"),
    ]);

    expect(importChangeLines(plan, snapshot)).toEqual([
      {
        layer: "base",
        kind: "+",
        module: "shell",
        file: "bashrc",
        what: "new file, 2 line(s)",
      },
    ]);
  });
});
