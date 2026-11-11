import { describe, expect, test } from "bun:test";
import { parseV2 } from "./v2.ts";

const CONFIG_FILE = "sync-config.v2.json";

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

function importNameError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs {layer} in importName.`;
}

function backslashError(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has a backslash in localPath.`;
}

function osError(file: string, os: string, module: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} lists os ${os} outside module ${module}.`;
}

describe("parseV2", () => {
  test("invalid JSON is rejected with exit 1", () => {
    // Act / Assert
    expectError("{ not json", `ERROR: ${CONFIG_FILE}: invalid JSON.`, 1);
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

  test("a schemaVersion other than 2 stops with exit 2", () => {
    // Arrange
    const text = configWith([], { schemaVersion: 3 });

    // Act / Assert
    expectError(text, `ERROR: ${CONFIG_FILE}: unsupported config schemaVersion 3.`, 2);
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
    expectError(text, `ERROR: ${CONFIG_FILE}: unsupported config schemaVersion 3.`, 2);
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

  test("an import entry whose importName has no {layer} stops with exit 1", () => {
    // Arrange
    const bad = entry({ merge: "import", importName: "CLAUDE.md" });

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

  test("a valid config with one entry of each merge type parses ok", () => {
    // Arrange
    const text = configWith([
      entry(),
      entry({ file: "vscode/settings.json", merge: "json" }),
      entry({ file: "claude/CLAUDE.md", merge: "import", importName: "CLAUDE.{layer}.md" }),
      entry({ file: "gnome/dconf/input.ini", module: "gnome", merge: "dconf", os: ["linux"] }),
      entry({ file: "vscode/snippets", merge: "dir" }),
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
