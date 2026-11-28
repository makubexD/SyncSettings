import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import type { SelectedEntry } from "../layers/select.ts";
import {
  renderSettingList,
  settingListHeader,
  settingRows,
} from "./settings.ts";
import type { SettingRow } from "./settings.ts";
import type { Values } from "../values/sanitize.ts";

const PROFILE_NAME = "work1";

const MACHINE_NAME = "wk1-laptop";

const PROFILE: Profile = {
  name: PROFILE_NAME,
  modules: ["vscode", "claude", "git", "shell", "tools", "docs", "bash"],
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

const CLAUDE: ConfigV2Entry = {
  file: "claude/settings.json",
  module: "claude",
  merge: "json",
  localPath: "~/.claude/settings.json",
};

const GIT: ConfigV2Entry = {
  file: "git/.gitconfig.local",
  module: "git",
  merge: "whole",
  localPath: "~/.gitconfig.local",
};

const SHELL: ConfigV2Entry = {
  file: "shell/.aliases",
  module: "shell",
  merge: "whole",
  localPath: "~/.aliases",
};

const TOOLS: ConfigV2Entry = {
  file: "tools/.toolrc",
  module: "tools",
  merge: "whole",
  localPath: "~/.toolrc",
};

const DOCS: ConfigV2Entry = {
  file: "docs/notes",
  module: "docs",
  merge: "dir",
  localPath: "~/notes",
};

const BASH: ConfigV2Entry = {
  file: "bash/.bashrc",
  module: "bash",
  merge: "import",
  localPath: "~/.bashrc",
  importName: ".bashrc.{layer}",
};

const TWELVE_LINES = Array.from(
  { length: 12 },
  (_, n) => `# line ${n + 1}\n`,
).join("");

const ALIASES = "alias ll='ls -l'\nalias la='ls -a'\nalias gs='git status'\n";

/** The repo and state layers of step 3's shared case, by snapshot path. */
const CASE_FILES: Readonly<Record<string, string>> = {
  "dotfiles/common/vscode/settings.json":
    '{\n  "editor.fontSize": 14,\n  "files.autoSave": "off"\n}\n',
  "dotfiles/linux/vscode/settings.json": '{\n  "window.zoomLevel": 1\n}\n',
  "profiles/work1/vscode/settings.json": '{\n  "editor.fontSize": 15\n}\n',
  "dotfiles/common/claude/settings.json":
    '{"permissions": {"allow": ["Bash(ls)", "Bash(cat)", "Bash(git status)", "Bash(git diff)"]}}\n',
  "profiles/work1/claude/settings.json":
    '{"permissions": {"allow": ["Bash(work-tool-1 status)", "Bash(work-tool-1 logs)"]}}\n',
  "dotfiles/linux/git/.gitconfig.local": TWELVE_LINES,
  "dotfiles/linux/shell/.aliases": ALIASES,
  "profiles/work1/shell/.aliases": ALIASES,
  "dotfiles/common/tools/.toolrc": "color=auto\n",
};

const CASE_LISTING = [
  "Settings above the base on wk1-laptop (profile work1):",
  "",
  "vscode  settings.json",
  "  editor.fontSize      all machines: 14  profile work1: 15",
  "  window.zoomLevel     Linux machines: 1",
  "claude  settings.json",
  "  permissions.allow[]  all machines: 4 item(s)  profile work1: 2 item(s)",
  "git     .gitconfig.local",
  "  (whole file)         Linux machines: 12 line(s)",
  "shell   .aliases",
  "  (whole file)         Linux machines: 3 line(s)  profile work1: same as Linux machines",
  "",
  "Other profiles: unknown while the repo is public.",
];

const NO_VALUES: Values = {};

/** A profile value and the machine record's, as `setting-list-hides-values`
 * and its machine twin hold them. */
const HIDDEN_VALUES: Values = {
  "<YOUR_TEAM>": "A4",
  "<WORK_HOST>": "gw.example.invalid",
};

/** A layer file a wider move emptied. */
const EMPTIED_LAYER = "{}\n";

const CASE_HEADER = settingListHeader({
  kind: "record",
  machine: MACHINE_NAME,
  profile: PROFILE_NAME,
});

function filesOf(
  texts: Readonly<Record<string, string>>,
): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map(
    Object.entries(texts).map(([path, text]) => [path, encoder.encode(text)]),
  );
}

function configOf(entries: readonly ConfigV2Entry[]): ConfigV2 {
  const modules = Object.fromEntries(
    entries.map((entry) => [entry.module, { description: entry.module }]),
  );
  return { schemaVersion: 2, modules, entries };
}

function selectedOf(
  entries: readonly ConfigV2Entry[],
  files: ReadonlyMap<string, Uint8Array>,
): readonly SelectedEntry[] {
  const selected = selectEntries(
    configOf(entries),
    { os: "linux", profile: PROFILE, machine: MACHINE_NAME },
    new Set(files.keys()),
  );
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  return selected.value;
}

function rowsOf(
  entries: readonly ConfigV2Entry[],
  texts: Readonly<Record<string, string>>,
  values: Values = NO_VALUES,
): readonly SettingRow[] {
  const files = filesOf(texts);
  return settingRows(selectedOf(entries, files), files, "linux", values);
}

/** A vscode entry whose profile layer sets `value` over a base of `{}`. */
function vscodeValueRows(value: string): readonly SettingRow[] {
  return rowsOf([VSCODE], {
    "dotfiles/common/vscode/settings.json": "{}\n",
    "profiles/work1/vscode/settings.json": `{"note": ${JSON.stringify(value)}}\n`,
  });
}

describe("settingRows and renderSettingList", () => {
  test("should list step 3's case as the contract writes it", () => {
    // Arrange
    const rows = rowsOf([VSCODE, CLAUDE, GIT, SHELL, TOOLS], CASE_FILES);

    // Act
    const lines = renderSettingList(CASE_HEADER, rows, "public");

    // Assert
    expect(lines).toEqual(CASE_LISTING);
  });

  test("should give a json key each layer's value, base first", () => {
    // Arrange
    const rows = rowsOf([VSCODE], CASE_FILES);

    // Act
    const fontSize = rows.find((row) => row.key === "editor.fontSize");

    // Assert
    expect(fontSize?.cells).toEqual([
      { group: "all machines", text: "14" },
      { group: "profile work1", text: "15" },
    ]);
  });

  test("should count an array path's items in each layer", () => {
    // Arrange
    const rows = rowsOf([CLAUDE], CASE_FILES);

    // Act
    const [allow] = rows;

    // Assert
    expect(allow).toEqual({
      module: "claude",
      file: "settings.json",
      key: "permissions.allow[]",
      cells: [
        { group: "all machines", text: "4 item(s)" },
        { group: "profile work1", text: "2 item(s)" },
      ],
    });
  });

  test("should name a whole file equal to a wider layer's after that layer", () => {
    // Arrange
    const rows = rowsOf([SHELL], CASE_FILES);

    // Act
    const [aliases] = rows;

    // Assert
    expect(aliases?.cells).toEqual([
      { group: "Linux machines", text: "3 line(s)" },
      { group: "profile work1", text: "same as Linux machines" },
    ]);
  });

  test("should list nothing when the only layer above the base is emptied to {}", () => {
    // Arrange
    const rows = rowsOf([VSCODE], {
      "dotfiles/common/vscode/settings.json": '{\n  "editor.fontSize": 14\n}\n',
      "profiles/work1/vscode/settings.json": EMPTIED_LAYER,
    });

    // Act
    const lines = renderSettingList(CASE_HEADER, rows, "public");

    // Assert
    expect(lines).toEqual([
      CASE_HEADER,
      "",
      "(none)",
      "",
      "Other profiles: unknown while the repo is public.",
    ]);
  });

  test("should print a profile value as its placeholder, never the value", () => {
    // Arrange
    const texts = {
      "dotfiles/common/vscode/settings.json": EMPTIED_LAYER,
      "profiles/work1/vscode/settings.json": '{"team": "A4"}\n',
    };

    // Act
    const [team] = rowsOf([VSCODE], texts, HIDDEN_VALUES);

    // Assert
    expect(team?.cells).toEqual([
      { group: "profile work1", text: '"<YOUR_TEAM>"' },
    ]);
  });

  test("should hide a machine value before the value is cut", () => {
    // Arrange
    const proxy = `http://gw.example.invalid:8080/${"p".repeat(20)}`;

    // Act
    const [note] = rowsOf(
      [VSCODE],
      {
        "dotfiles/common/vscode/settings.json": EMPTIED_LAYER,
        "profiles/work1/vscode/settings.json": `{"note": ${JSON.stringify(proxy)}}\n`,
      },
      HIDDEN_VALUES,
    );

    // Assert
    // The hidden text is 37 characters up to the cut: 25, then 12 of the p's.
    expect(note?.cells[0]?.text).toBe(
      `"http://<WORK_HOST>:8080/${"p".repeat(12)}...`,
    );
  });

  test("should leave out an entry with only a base file", () => {
    // Arrange
    const texts = { "dotfiles/common/tools/.toolrc": "color=auto\n" };

    // Act
    const rows = rowsOf([TOOLS], texts);

    // Assert
    expect(rows).toEqual([]);
  });

  test("should cut a value of 41 characters to 37 and an ellipsis", () => {
    // Arrange
    const value = "a".repeat(39);

    // Act
    const [row] = vscodeValueRows(value);

    // Assert
    expect(row?.cells).toEqual([
      { group: "profile work1", text: `"${"a".repeat(36)}...` },
    ]);
  });

  test("should keep a value of exactly 40 characters", () => {
    // Arrange
    const value = "a".repeat(38);

    // Act
    const [row] = vscodeValueRows(value);

    // Assert
    expect(row?.cells).toEqual([
      { group: "profile work1", text: `"${value}"` },
    ]);
  });

  test("should list a dir entry's file as <file>/<name>", () => {
    // Arrange
    const texts = {
      "dotfiles/common/docs/notes/a.md": "base\n",
      "profiles/work1/docs/notes/b.md": "one\ntwo\n",
    };

    // Act
    const rows = rowsOf([DOCS], texts);

    // Assert
    expect(rows).toEqual([
      {
        module: "docs",
        file: "docs/notes/b.md",
        cells: [{ group: "profile work1", text: "2 line(s)" }],
      },
    ]);
  });

  test("should list an import side file by its resolved name", () => {
    // Arrange
    const texts = {
      "dotfiles/common/bash/.bashrc": "base\n",
      "dotfiles/linux/bash/.bashrc": "linux\n",
    };

    // Act
    const rows = rowsOf([BASH], texts);

    // Assert
    expect(rows).toEqual([
      {
        module: "bash",
        file: ".bashrc.linux",
        cells: [{ group: "Linux machines", text: "1 line(s)" }],
      },
    ]);
  });

  test("should print (none) when nothing is above the base", () => {
    // Arrange
    const header = settingListHeader({ kind: "none" });

    // Act
    const lines = renderSettingList(header, [], "public");

    // Assert
    expect(lines).toEqual([
      "Settings above the base on this machine:",
      "",
      "(none)",
      "",
      "Other profiles: unknown while the repo is public.",
    ]);
  });

  test("should end without the public line once the repo is private", () => {
    // Arrange
    const header = settingListHeader({ kind: "profile", profile: "work2" });

    // Act
    const lines = renderSettingList(header, [], "private");

    // Assert
    expect(lines).toEqual([
      "Settings above the base in profile work2:",
      "",
      "(none)",
    ]);
  });

  test("should print a key holding a dot as the change block prints it", () => {
    // Arrange
    const texts = {
      "dotfiles/common/vscode/settings.json": "{}\n",
      "dotfiles/linux/vscode/settings.json":
        '{"[python]": {"editor.formatOnSave": true}}\n',
    };

    // Act
    const rows = rowsOf([VSCODE], texts);

    // Assert
    expect(rows.map((row) => row.key)).toEqual([
      "[python].editor.formatOnSave",
    ]);
  });
});
