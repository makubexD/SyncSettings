import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkV1V2 } from "./check.ts";
import { parseV1 } from "./v1.ts";
import { parseV2 } from "./v2.ts";
import type {
  ConfigV1,
  ConfigV1Entry,
  ConfigV2,
  ConfigV2Entry,
  EntryType,
  MergeType,
  Os,
  Platform,
  SanitizeRule,
} from "./types.ts";

const MODULES: ConfigV2["modules"] = { test: { description: "Test module" } };

interface V1Options {
  readonly repoPath: string;
  readonly localPath?: string;
  readonly localPaths?: Readonly<Partial<Record<Os, string>>>;
  readonly platform?: Platform;
  readonly sanitizeRules?: readonly SanitizeRule[];
  readonly type?: EntryType;
  readonly path?: string;
  readonly keys?: readonly string[];
}

interface V2Options {
  readonly file: string;
  readonly merge?: MergeType;
  readonly localPath?: string;
  readonly localPaths?: Readonly<Partial<Record<Os, string>>>;
  readonly os?: readonly Os[];
  readonly sanitize?: readonly SanitizeRule[];
  readonly dconfPath?: string;
  readonly keys?: readonly string[];
  readonly module?: string;
}

function rule(placeholder: string): SanitizeRule {
  return { placeholder, prompt: `Value for ${placeholder}` };
}

function v1Entry(options: V1Options): ConfigV1Entry {
  return {
    repoPath: options.repoPath,
    ...(options.localPath !== undefined ? { localPath: options.localPath } : {}),
    ...(options.localPaths !== undefined ? { localPaths: options.localPaths } : {}),
    platform: options.platform ?? "common",
    ...(options.sanitizeRules !== undefined ? { sanitizeRules: options.sanitizeRules } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.keys !== undefined ? { keys: options.keys } : {}),
  };
}

function v2Entry(options: V2Options): ConfigV2Entry {
  return {
    file: options.file,
    module: options.module ?? "test",
    merge: options.merge ?? "whole",
    ...(options.localPath !== undefined ? { localPath: options.localPath } : {}),
    ...(options.localPaths !== undefined ? { localPaths: options.localPaths } : {}),
    ...(options.os !== undefined ? { os: options.os } : {}),
    ...(options.sanitize !== undefined ? { sanitize: options.sanitize } : {}),
    ...(options.dconfPath !== undefined ? { dconfPath: options.dconfPath } : {}),
    ...(options.keys !== undefined ? { keys: options.keys } : {}),
  };
}

function v1Config(files: readonly ConfigV1Entry[]): ConfigV1 {
  return { files };
}

function v2Config(entries: readonly ConfigV2Entry[]): ConfigV2 {
  return { schemaVersion: 2, modules: MODULES, entries };
}

describe("checkV1V2", () => {
  test("a v1 entry and its v2 entry in step report nothing", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({
        repoPath: "dotfiles/linux/git/.gitconfig.local",
        localPath: "~/.gitconfig.local",
        platform: "linux",
      }),
    ]);
    const v2 = v2Config([
      v2Entry({
        file: "git/.gitconfig.local",
        os: ["linux"],
        localPath: "~/.gitconfig.local",
      }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([]);
  });

  test("a common v1 entry with no v2 entry reports every OS in order", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({ repoPath: "dotfiles/common/git/.gitconfig", localPath: "~/.gitconfig" }),
    ]);
    const v2 = v2Config([]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([
      "dotfiles/common/git/.gitconfig: no v2 entry for git/.gitconfig on windows",
      "dotfiles/common/git/.gitconfig: no v2 entry for git/.gitconfig on linux",
      "dotfiles/common/git/.gitconfig: no v2 entry for git/.gitconfig on macos",
    ]);
  });

  test("a local path differing from v2 is reported for that OS", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({
        repoPath: "dotfiles/linux/git/.gitconfig.local",
        localPath: "~/.gitconfig.local",
        platform: "linux",
      }),
    ]);
    const v2 = v2Config([
      v2Entry({ file: "git/.gitconfig.local", os: ["linux"], localPath: "~/.config/git/local" }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([
      "dotfiles/linux/git/.gitconfig.local: local path on linux differs from v2 (~/.gitconfig.local vs ~/.config/git/local)",
    ]);
  });

  test("placeholders are sorted, deduplicated and reported when they differ", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({
        repoPath: "dotfiles/linux/git/.gitconfig",
        localPath: "~/.gitconfig",
        platform: "linux",
        sanitizeRules: [rule("<B>"), rule("<A>"), rule("<B>")],
      }),
    ]);
    const v2 = v2Config([
      v2Entry({
        file: "git/.gitconfig",
        os: ["linux"],
        localPath: "~/.gitconfig",
        sanitize: [rule("<A>")],
      }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([
      "dotfiles/linux/git/.gitconfig: placeholders on linux differ from v2 (<A>, <B> vs <A>)",
    ]);
  });

  test("dconf keys differing from v2 are reported", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({
        repoPath: "dotfiles/linux/gnome/dconf/shell.ini",
        platform: "linux",
        type: "dconf",
        path: "/org/gnome/shell/",
        keys: ["favorite-apps"],
      }),
    ]);
    const v2 = v2Config([
      v2Entry({
        file: "gnome/dconf/shell.ini",
        os: ["linux"],
        merge: "dconf",
        dconfPath: "/org/gnome/shell/",
        keys: ["enabled-extensions"],
      }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([
      "dotfiles/linux/gnome/dconf/shell.ini: dconf path or keys on linux differ from v2",
    ]);
  });

  test("a v2 entry covering an OS that v1 does not is reported", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({ repoPath: "dotfiles/linux/git/.gitconfig.local", localPath: "~/.gitconfig.local", platform: "linux" }),
    ]);
    const v2 = v2Config([
      v2Entry({ file: "git/.gitconfig.local", os: ["linux", "macos"], localPath: "~/.gitconfig.local" }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual(["git/.gitconfig.local: v2 covers macos, v1 does not"]);
  });

  test("json in v2 against whole in v1 is not a mismatch", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({ repoPath: "dotfiles/linux/vscode/settings.json", localPath: "~/.config/Code/User/settings.json", platform: "linux" }),
    ]);
    const v2 = v2Config([
      v2Entry({
        file: "vscode/settings.json",
        os: ["linux"],
        merge: "json",
        localPath: "~/.config/Code/User/settings.json",
      }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([]);
  });

  test("a v2-only file reports nothing", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({ repoPath: "dotfiles/linux/git/.gitconfig.local", localPath: "~/.gitconfig.local", platform: "linux" }),
    ]);
    const v2 = v2Config([
      v2Entry({ file: "git/.gitconfig.local", os: ["linux"], localPath: "~/.gitconfig.local" }),
      v2Entry({ file: "extra/file", localPath: "~/.extra" }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([]);
  });

  test("a backslash local path in v1 matches a forward-slash one in v2", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({
        repoPath: "dotfiles/windows/shell/.bashrc",
        localPath: "~\\.bashrc",
        platform: "windows",
      }),
    ]);
    const v2 = v2Config([
      v2Entry({ file: "shell/.bashrc", os: ["windows"], localPath: "~/.bashrc" }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual([]);
  });

  test("a v1 repo path under no layer root is reported once", () => {
    // Arrange
    const v1 = v1Config([v1Entry({ repoPath: "elsewhere/git/.gitconfig", localPath: "~/.gitconfig" })]);
    const v2 = v2Config([]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual(["elsewhere/git/.gitconfig: no v2 layer root matches this path"]);
  });

  test("two v1 entries sharing a file and OS report a duplicate", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({ repoPath: "dotfiles/linux/git/.gitconfig", localPath: "~/.gitconfig", platform: "linux" }),
      v1Entry({ repoPath: "dotfiles/linux/git/.gitconfig", localPath: "~/.gitconfig", platform: "linux" }),
    ]);
    const v2 = v2Config([
      v2Entry({ file: "git/.gitconfig", os: ["linux"], localPath: "~/.gitconfig" }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual(["dotfiles/linux/git/.gitconfig: duplicate entry for linux"]);
  });

  test("two v2 entries sharing a file and OS report a duplicate", () => {
    // Arrange
    const v1 = v1Config([
      v1Entry({ repoPath: "dotfiles/linux/git/.gitconfig", localPath: "~/.gitconfig", platform: "linux" }),
    ]);
    const v2 = v2Config([
      v2Entry({ file: "git/.gitconfig", os: ["linux"], localPath: "~/.gitconfig" }),
      v2Entry({ file: "git/.gitconfig", os: ["linux"], localPath: "~/.gitconfig" }),
    ]);

    // Act
    const lines = checkV1V2(v1, v2);

    // Assert
    expect(lines).toEqual(["git/.gitconfig: duplicate entry for linux"]);
  });

  test("the repo's own sync-config.json and sync-config.v2.json are in step", () => {
    // Arrange
    const v1Text = readFileSync(new URL("../../../sync-config.json", import.meta.url), "utf8");
    const v2Text = readFileSync(
      new URL("../../../sync-config.v2.json", import.meta.url),
      "utf8",
    );
    const parsedV1 = parseV1(v1Text);
    const parsedV2 = parseV2(v2Text);
    expect(parsedV1.ok).toBe(true);
    expect(parsedV2.ok).toBe(true);
    if (!parsedV1.ok || !parsedV2.ok) {
      return;
    }

    // Act
    const lines = checkV1V2(parsedV1.value, parsedV2.value);

    // Assert
    expect(lines).toEqual([]);
  });
});
