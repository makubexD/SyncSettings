import { describe, expect, test } from "bun:test";
import { SUGGEST_SOURCES } from "./types.ts";
import type { SuggestSource } from "./types.ts";
import { parseV2 } from "./v2.ts";

const CONFIG_FILE = "sync-config.json";

const MODULES = {
  git: { description: "Git settings" },
  gnome: { description: "GNOME desktop", os: ["linux"] },
} as const;

const SAFE_ENTRY = {
  file: "git/.gitconfig",
  module: "git",
  merge: "whole",
  localPath: "~/.gitconfig",
};

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SAFE_ENTRY, ...overrides };
}

function dconfEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return entry({
    file: "gnome/dconf/input.ini",
    module: "gnome",
    merge: "dconf",
    localPath: undefined,
    os: ["linux"],
    ...overrides,
  });
}

function configWith(
  entries: readonly unknown[],
  options: { readonly schemaVersion?: unknown; readonly modules?: unknown } = {},
): string {
  return JSON.stringify({
    schemaVersion: options.schemaVersion ?? 2,
    modules: options.modules ?? MODULES,
    entries,
  });
}

function expectError(text: string, message: string, code: 1 | 2): void {
  // Act
  const result = parseV2(text);

  // Assert
  expect(result).toEqual({ ok: false, error: { message, code } });
}

function unsafePathError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an unsafe path.`;
}

function unknownModuleError(file: string, module: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} names unknown module ${module}.`;
}

function unknownMergeError(file: string, merge: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an unknown merge ${merge}.`;
}

function escapeBackslashesError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} can not use escapeBackslashes with merge json.`;
}

function elevateError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has elevate other than false.`;
}

function linkedError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has linked other than true.`;
}

function importNameError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs {layer} in importName.`;
}

function dconfPathError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs a dconfPath like /org/gnome/shell/.`;
}

function backslashError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has a backslash in localPath.`;
}

function localPathsKeyError(file: string, key: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an unknown localPaths key ${key}.`;
}

function suggestError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an invalid suggest.`;
}

function defaultEnvError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an invalid defaultEnv.`;
}

function osError(file: string, os: string, module: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} lists os ${os} outside module ${module}.`;
}

function entryShapeError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs file and localPath as strings.`;
}

function entryOsError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an os that is not a list of linux, macos or windows.`;
}

function moduleOsError(module: string): string {
  return `ERROR: ${CONFIG_FILE}: module ${module} has an os that is not a list of linux, macos or windows.`;
}

function canNotUseError(file: string, field: string, merge: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} can not use ${field} with merge ${merge}.`;
}

function insideDirError(file: string, dir: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} is inside dir entry ${dir}.`;
}

function trailingSlashError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has a trailing / in file.`;
}

function keysError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs keys as a non-empty list of strings.`;
}

describe("parseV2", () => {
  test("invalid JSON is rejected with exit 1", () => {
    // Act / Assert
    expectError("{ not json", `ERROR: ${CONFIG_FILE}: invalid JSON.`, 1);
  });

  test("an error names the config file it is given", () => {
    // Act
    const result = parseV2("{ not json", "sync-config.json");

    // Assert
    expect(result).toEqual({
      ok: false,
      error: { message: "ERROR: sync-config.json: invalid JSON.", code: 1 },
    });
  });

  test("a config that is not an object is rejected with exit 1", () => {
    // Act / Assert
    expectError("[]", `ERROR: ${CONFIG_FILE}: invalid JSON.`, 1);
  });

  test("a missing schemaVersion stops with exit 2", () => {
    // Arrange
    const text = JSON.stringify({ modules: MODULES, entries: [] });

    // Act / Assert
    expectError(text, `ERROR: ${CONFIG_FILE}: unsupported config schemaVersion none.`, 2);
  });

  test("a schemaVersion above 2 stops with the newer-mksync line", () => {
    // Arrange
    const text = configWith([], { schemaVersion: 3 });

    // Act / Assert
    expectError(
      text,
      `ERROR: ${CONFIG_FILE}: this config needs a newer mksync: run mksync update.`,
      2,
    );
  });

  test("a far future schemaVersion stops with the newer-mksync line", () => {
    // Arrange
    const text = configWith([], { schemaVersion: 99 });

    // Act / Assert
    expectError(
      text,
      `ERROR: ${CONFIG_FILE}: this config needs a newer mksync: run mksync update.`,
      2,
    );
  });

  test("a schemaVersion below 2 stops with the unsupported line", () => {
    // Arrange
    const text = configWith([], { schemaVersion: 1 });

    // Act / Assert
    expectError(text, `ERROR: ${CONFIG_FILE}: unsupported config schemaVersion 1.`, 2);
  });

  test("a string schemaVersion is shown as JSON", () => {
    // Arrange
    const text = configWith([], { schemaVersion: "2" });

    // Act / Assert
    expectError(text, `ERROR: ${CONFIG_FILE}: unsupported config schemaVersion "2".`, 2);
  });

  test("the schemaVersion check runs before the entry checks", () => {
    // Arrange
    const bad = entry({ module: "nope" });
    const text = configWith([bad], { schemaVersion: 3 });

    // Act / Assert
    expectError(
      text,
      `ERROR: ${CONFIG_FILE}: this config needs a newer mksync: run mksync update.`,
      2,
    );
  });

  test("an entry naming an unknown module stops with exit 1", () => {
    // Arrange
    const bad = entry({ module: "nope" });

    // Act / Assert
    expectError(configWith([bad]), unknownModuleError(bad.file as string, "nope"), 1);
  });

  test("an entry with an unknown merge stops with exit 1", () => {
    // Arrange
    const bad = entry({ merge: "replace" });

    // Act / Assert
    expectError(configWith([bad]), unknownMergeError(bad.file as string, "replace"), 1);
  });

  test("escapeBackslashes on a json entry stops with exit 1", () => {
    // Arrange
    const bad = entry({
      merge: "json",
      sanitize: [{ placeholder: "<X>", prompt: "X", escapeBackslashes: true }],
    });

    // Act / Assert
    expectError(configWith([bad]), escapeBackslashesError(bad.file as string), 1);
  });

  test("an elevate other than false stops with exit 1", () => {
    // Arrange
    const bad = entry({ elevate: true });

    // Act / Assert
    expectError(configWith([bad]), elevateError(bad.file as string), 1);
  });

  test("a file entry with linked true is accepted", () => {
    // Arrange
    const good = entry({ linked: true });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("a linked value that is not true stops with exit 1", () => {
    // Arrange
    const bad = entry({ linked: "yes" });

    // Act / Assert
    expectError(configWith([bad]), linkedError(bad.file as string), 1);
  });

  test("an import entry whose importName has no {layer} stops with exit 1", () => {
    // Arrange
    const bad = entry({ merge: "import", importName: "CLAUDE.md" });

    // Act / Assert
    expectError(configWith([bad]), importNameError(bad.file as string), 1);
  });

  test("an import entry with no importName stops with exit 1", () => {
    // Arrange
    const bad = entry({ merge: "import" });

    // Act / Assert
    expectError(configWith([bad]), importNameError(bad.file as string), 1);
  });

  test("a localPath with a backslash stops with exit 1", () => {
    // Arrange
    const bad = entry({ localPath: "~\\.gitconfig" });

    // Act / Assert
    expectError(configWith([bad]), backslashError(bad.file as string), 1);
  });

  test("a localPaths value with a backslash stops with exit 1", () => {
    // Arrange
    const bad = entry({ localPaths: { windows: "~\\AppData\\x.conf" } });

    // Act / Assert
    expectError(configWith([bad]), backslashError(bad.file as string), 1);
  });

  test("a localPaths key that is not an OS name stops with exit 1", () => {
    // Arrange
    const bad = entry({ localPaths: { freebsd: "~/.config/x.conf" } });

    // Act / Assert
    expectError(configWith([bad]), localPathsKeyError(bad.file as string, "freebsd"), 1);
  });

  test("a sanitize rule whose defaultEnv is not a variable name stops with exit 1", () => {
    // Arrange
    const bad = entry({ sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name", defaultEnv: "1BAD" }] });

    // Act / Assert
    expectError(configWith([bad]), defaultEnvError(bad.file as string), 1);
  });

  test.each([...SUGGEST_SOURCES])("a sanitize rule with suggest %s is read as a list of it", (suggest) => {
    // Arrange
    const good = entry({ sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name", suggest }] });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok && result.value.entries[0]?.sanitize?.[0]?.suggest).toEqual([suggest]);
  });

  test("a sanitize rule with a list of two sources keeps them in order", () => {
    // Arrange
    const sources: readonly SuggestSource[] = ["gh-hosts-login", "origin-owner"];
    const good = entry({ sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name", suggest: sources }] });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok && result.value.entries[0]?.sanitize?.[0]?.suggest).toEqual(sources);
  });

  const UNKNOWN_SUGGESTS: readonly [unknown, string][] = [
    ["x", "x"],
    [["gh-login", "x"], "x"],
    [["x", "y"], "x"],
  ];

  test.each(UNKNOWN_SUGGESTS)("a sanitize rule with suggest %p names source %s and mksync update, exit 2", (suggest, source) => {
    // Arrange
    const bad = entry({ sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name", suggest }] });

    // Act / Assert
    expectError(
      configWith([bad]),
      `ERROR: ${CONFIG_FILE}: entry ${bad.file as string} has an unknown suggest source ${source}; if the config is newer, run mksync update.`,
      2,
    );
  });

  const INVALID_SUGGESTS: readonly [unknown][] = [[1], [[]], [["gh-login", "gh-login"]], [["gh-login", 1]], [["x", 1]], [["x", "x"]], [null]];

  test.each(INVALID_SUGGESTS)("a sanitize rule with suggest %p stops with exit 1", (suggest) => {
    // Arrange
    const bad = entry({ sanitize: [{ placeholder: "<YOUR_NAME>", prompt: "Full name", suggest }] });

    // Act / Assert
    expectError(configWith([bad]), suggestError(bad.file as string), 1);
  });

  test("an unknown name beside another rule's wrong shape keeps exit 1", () => {
    // Arrange
    const bad = entry({
      sanitize: [
        { placeholder: "<A>", prompt: "A", suggest: 1 },
        { placeholder: "<B>", prompt: "B", suggest: "future" },
      ],
    });

    // Act / Assert
    expectError(configWith([bad]), suggestError(bad.file as string), 1);
  });

  test("a sanitize rule with no suggest is read as it is", () => {
    // Arrange
    const rule = { placeholder: "<YOUR_NAME>", prompt: "Full name" };

    // Act
    const result = parseV2(configWith([entry({ sanitize: [rule] })]));

    // Assert
    expect(result.ok && result.value.entries[0]?.sanitize?.[0]).toEqual(rule);
  });

  test("a sanitize rule with a valid defaultEnv and OS-named localPaths are accepted", () => {
    // Arrange
    const good = entry({
      localPaths: { macos: "~/Library/x.conf" },
      sanitize: [{ placeholder: "<HOME>", prompt: "Home", defaultEnv: "HOME" }],
    });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("an entry os outside its module os stops with exit 1", () => {
    // Arrange
    const bad = entry({ module: "gnome", os: ["windows"] });

    // Act / Assert
    expectError(configWith([bad]), osError(bad.file as string, "windows", "gnome"), 1);
  });

  test("an entry os inside its module os is accepted", () => {
    // Arrange
    const good = entry({ module: "gnome", os: ["linux"] });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("an entry os is accepted when its module has no os", () => {
    // Arrange
    const good = entry({ os: ["windows"] });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("an entry that is not an object stops with exit 1", () => {
    // Arrange
    const text = configWith([42]);

    // Act / Assert
    expectError(text, entryShapeError("42"), 1);
  });

  test("an entry with no file stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: undefined });

    // Act / Assert
    expectError(configWith([bad]), entryShapeError("none"), 1);
  });

  test("an entry with a non-string file stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: 7 });

    // Act / Assert
    expectError(configWith([bad]), entryShapeError("7"), 1);
  });

  test("an entry file with a .. segment stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: "../x" });

    // Act / Assert
    expectError(configWith([bad]), unsafePathError("../x"), 1);
  });

  test("an absolute entry file stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: "/etc/x" });

    // Act / Assert
    expectError(configWith([bad]), unsafePathError("/etc/x"), 1);
  });

  test("an entry file starting with a drive letter stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: "C:/x" });

    // Act / Assert
    expectError(configWith([bad]), unsafePathError("C:/x"), 1);
  });

  test("an entry file with a backslash stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: "a\\b" });

    // Act / Assert
    expectError(configWith([bad]), unsafePathError("a\\b"), 1);
  });

  test("an empty entry file stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: "" });

    // Act / Assert
    expectError(configWith([bad]), unsafePathError(""), 1);
  });

  test("an entry file with a folder is accepted", () => {
    // Arrange
    const good = entry({ file: "a/b.json" });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("a non-dconf entry with no localPath stops with exit 1", () => {
    // Arrange
    const bad = entry({ localPath: undefined });

    // Act / Assert
    expectError(configWith([bad]), entryShapeError(bad.file as string), 1);
  });

  test("a non-dconf entry with a non-string localPath stops with exit 1", () => {
    // Arrange
    const bad = entry({ localPath: 3 });

    // Act / Assert
    expectError(configWith([bad]), entryShapeError(bad.file as string), 1);
  });

  test("a dconf entry needs no localPath", () => {
    // Arrange
    const good = dconfEntry({ dconfPath: "/org/gnome/shell/" });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("a dconf entry whose dconfPath is the root stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry({ dconfPath: "/" });

    // Act / Assert
    expectError(configWith([bad]), dconfPathError(bad.file as string), 1);
  });

  test("a dconf entry whose dconfPath is an option stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry({ dconfPath: "--version" });

    // Act / Assert
    expectError(configWith([bad]), dconfPathError(bad.file as string), 1);
  });

  test("a dconf entry with no dconfPath stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry();

    // Act / Assert
    expectError(configWith([bad]), dconfPathError(bad.file as string), 1);
  });

  test("a dconf entry with a folder dconfPath is accepted", () => {
    // Arrange
    const good = dconfEntry({ dconfPath: "/org/gnome/shell/" });

    // Act
    const result = parseV2(configWith([good]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("an entry os that is not a list stops with exit 1", () => {
    // Arrange
    const bad = entry({ os: "linux" });

    // Act / Assert
    expectError(configWith([bad]), entryOsError(bad.file as string), 1);
  });

  test("an entry os naming another system stops with exit 1", () => {
    // Arrange
    const bad = entry({ os: ["freebsd"] });

    // Act / Assert
    expectError(configWith([bad]), entryOsError(bad.file as string), 1);
  });

  test("a module os that is not a list stops with exit 1", () => {
    // Arrange
    const modules = { git: { description: "Git settings", os: "linux" } };
    const text = configWith([], { modules });

    // Act / Assert
    expectError(text, moduleOsError("git"), 1);
  });

  test("a module os naming another system stops with exit 1", () => {
    // Arrange
    const modules = { git: { description: "Git settings", os: ["freebsd"] } };
    const text = configWith([], { modules });

    // Act / Assert
    expectError(text, moduleOsError("git"), 1);
  });

  test("a valid config with one entry of each merge type parses ok", () => {
    // Arrange
    const text = configWith([
      entry(),
      entry({ file: "vscode/settings.json", merge: "json" }),
      entry({ file: "claude/CLAUDE.md", merge: "import", importName: "CLAUDE.{layer}.md" }),
      dconfEntry({ dconfPath: "/org/gnome/shell/" }),
      entry({ file: "vscode/snippets", merge: "dir" }),
    ]);

    // Act
    const result = parseV2(text);

    // Assert
    expect(result.ok).toBe(true);
  });

  test("sanitize on a dir entry stops with exit 1", () => {
    // Arrange
    const bad = entry({
      file: "vscode/snippets",
      merge: "dir",
      sanitize: [{ placeholder: "<X>", prompt: "X" }],
    });

    // Act / Assert
    expectError(
      configWith([bad]),
      canNotUseError("vscode/snippets", "sanitize", "dir"),
      1,
    );
  });

  test("localPath on a dconf entry stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry({
      dconfPath: "/org/gnome/shell/",
      localPath: "~/.config/dconf/user",
    });

    // Act / Assert
    expectError(
      configWith([bad]),
      canNotUseError(bad.file as string, "localPath", "dconf"),
      1,
    );
  });

  test("sanitize on a dconf entry stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry({
      dconfPath: "/org/gnome/shell/",
      sanitize: [{ placeholder: "<X>", prompt: "X" }],
    });

    // Act / Assert
    expectError(
      configWith([bad]),
      canNotUseError(bad.file as string, "sanitize", "dconf"),
      1,
    );
  });

  test("keys on a whole entry stops with exit 1", () => {
    // Arrange
    const bad = entry({ keys: ["font-name"] });

    // Act / Assert
    expectError(configWith([bad]), canNotUseError(bad.file as string, "keys", "whole"), 1);
  });

  test("dconfPath on a dir entry stops with exit 1", () => {
    // Arrange
    const bad = entry({
      file: "vscode/snippets",
      merge: "dir",
      dconfPath: "/org/gnome/shell/",
    });

    // Act / Assert
    expectError(
      configWith([bad]),
      canNotUseError("vscode/snippets", "dconfPath", "dir"),
      1,
    );
  });

  test("an entry file inside a dir entry stops with exit 1", () => {
    // Arrange
    const text = configWith([
      entry({ file: "d", merge: "dir" }),
      entry({ file: "d/x.txt" }),
    ]);

    // Act / Assert
    expectError(text, insideDirError("d/x.txt", "d"), 1);
  });

  test("a dir entry inside another dir entry stops with exit 1", () => {
    // Arrange
    const text = configWith([
      entry({ file: "d", merge: "dir" }),
      entry({ file: "d/e", merge: "dir" }),
    ]);

    // Act / Assert
    expectError(text, insideDirError("d/e", "d"), 1);
  });

  test("a file with a trailing slash stops with exit 1", () => {
    // Arrange
    const bad = entry({ file: "d/" });

    // Act / Assert
    expectError(configWith([bad]), trailingSlashError("d/"), 1);
  });

  test("a dconf entry with an empty keys list stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry({ dconfPath: "/org/gnome/shell/", keys: [] });

    // Act / Assert
    expectError(configWith([bad]), keysError(bad.file as string), 1);
  });

  test("a dconf entry with keys that are not a list stops with exit 1", () => {
    // Arrange
    const bad = dconfEntry({ dconfPath: "/org/gnome/shell/", keys: "font-name" });

    // Act / Assert
    expectError(configWith([bad]), keysError(bad.file as string), 1);
  });

  test("sibling files that share a dir prefix are accepted", () => {
    // Arrange
    const text = configWith([
      entry({ file: "d", merge: "dir" }),
      entry({ file: "dir2", merge: "dir" }),
      entry({ file: "d-old/x.txt" }),
    ]);

    // Act
    const result = parseV2(text);

    // Assert
    expect(result.ok).toBe(true);
  });

  test("docs/config-v2.example.json parses ok", async () => {
    // Arrange
    const path = `${import.meta.dir}/../../../docs/config-v2.example.json`;
    const text = await Bun.file(path).text();

    // Act
    const result = parseV2(text);

    // Assert
    expect(result.ok).toBe(true);
  });
});
