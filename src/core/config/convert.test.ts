import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { convertV1 } from "./convert.ts";
import { parseV1 } from "./v1.ts";
import { parseV2 } from "./v2.ts";
import type {
  ConfigError,
  ConfigV1,
  ConfigV1Entry,
  ConfigV2,
  ConfigV2Entry,
  Result,
} from "./types.ts";

const MODULES = { unsorted: { description: "Entries converted from v1, not sorted yet." } };

interface Extra {
  readonly version?: number;
  readonly defaultUser?: string | null;
  readonly excludePatterns?: readonly string[];
}

function configOf(files: readonly ConfigV1Entry[], extra: Extra = {}): ConfigV1 {
  return {
    files,
    ...(extra.version !== undefined ? { version: extra.version } : {}),
    ...(extra.defaultUser !== undefined ? { defaultUser: extra.defaultUser } : {}),
    ...(extra.excludePatterns !== undefined ? { excludePatterns: extra.excludePatterns } : {}),
  };
}

function convert(
  files: readonly ConfigV1Entry[],
  extra: Extra = {},
): Result<ConfigV2, ConfigError> {
  return convertV1(configOf(files, extra));
}

function expected(entries: readonly ConfigV2Entry[], excludePatterns?: readonly string[]): ConfigV2 {
  return excludePatterns === undefined
    ? { schemaVersion: 2, modules: MODULES, entries }
    : { schemaVersion: 2, excludePatterns, modules: MODULES, entries };
}

function noRootError(repoPath: string): { ok: false; error: ConfigError } {
  return {
    ok: false,
    error: { message: `ERROR: ${repoPath}: no v2 layer root matches this path`, code: 1 },
  };
}

describe("convertV1", () => {
  test("version: the v1 version becomes schemaVersion 2", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [];

    // Act
    const result = convert(files, { version: 1 });

    // Assert
    expect(result).toEqual({ ok: true, value: expected([]) });
  });

  test("defaultUser: the field is dropped", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [];

    // Act
    const result = convert(files, { defaultUser: "someone" });

    // Assert
    expect(result).toEqual({ ok: true, value: expected([]) });
  });

  test("excludePatterns: the list is copied unchanged", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [];
    const excludePatterns = ["*.pem", "*.key"];

    // Act
    const result = convert(files, { excludePatterns });

    // Assert
    expect(result).toEqual({ ok: true, value: expected([], excludePatterns) });
  });

  test("files: an entry becomes an entry under the unsorted module", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/git/ignore",
        localPath: "~/.config/git/ignore",
        platform: "common",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "git/ignore",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.config/git/ignore",
        },
      ]),
    });
  });

  test("repoPath: the layer root is split off the file", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/linux/shell/.bashrc",
        localPath: "~/.bashrc",
        platform: "linux",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "shell/.bashrc",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.bashrc",
          os: ["linux"],
        },
      ]),
    });
  });

  test("localPath: the field is copied unchanged when it has no backslash", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/git/.gitconfig",
        localPath: "~/.gitconfig",
        platform: "common",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "git/.gitconfig",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.gitconfig",
        },
      ]),
    });
  });

  test("localPaths: the per-OS map is copied unchanged", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/vscode/settings.json",
        localPath: "~/.config/Code/User/settings.json",
        localPaths: { macos: "~/Library/Application Support/Code/User/settings.json" },
        platform: ["linux", "macos"],
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "vscode/settings.json",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.config/Code/User/settings.json",
          localPaths: { macos: "~/Library/Application Support/Code/User/settings.json" },
          os: ["linux", "macos"],
        },
      ]),
    });
  });

  test("platform: common carries no os", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/tmux/.tmux.conf",
        localPath: "~/.tmux.conf",
        platform: "common",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        { file: "tmux/.tmux.conf", module: "unsorted", merge: "whole", localPath: "~/.tmux.conf" },
      ]),
    });
  });

  test("description: the field is copied unchanged", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/git/.gitconfig",
        localPath: "~/.gitconfig",
        platform: "common",
        description: "Git global configuration",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "git/.gitconfig",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.gitconfig",
          description: "Git global configuration",
        },
      ]),
    });
  });

  test("type dir: merge dir", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/linux/rtk",
        localPath: "~/.config/rtk",
        platform: "linux",
        type: "dir",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "rtk",
          module: "unsorted",
          merge: "dir",
          localPath: "~/.config/rtk",
          os: ["linux"],
        },
      ]),
    });
  });

  test("type dconf: merge dconf", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/linux/gnome/dconf/interface.ini",
        platform: "linux",
        path: "/org/gnome/desktop/interface/",
        type: "dconf",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "gnome/dconf/interface.ini",
          module: "unsorted",
          merge: "dconf",
          os: ["linux"],
          dconfPath: "/org/gnome/desktop/interface/",
        },
      ]),
    });
  });

  test("type absent: merge whole", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/git/ignore",
        localPath: "~/.config/git/ignore",
        platform: "common",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "git/ignore",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.config/git/ignore",
        },
      ]),
    });
  });

  test("sanitizeRules: the rules become sanitize unchanged", () => {
    // Arrange
    const rule = { placeholder: "<HOME>", prompt: "Home directory", defaultEnv: "HOME" };
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/linux/gnome/bookmarks",
        localPath: "~/.config/gtk-3.0/bookmarks",
        platform: "linux",
        sanitizeRules: [rule],
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "gnome/bookmarks",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.config/gtk-3.0/bookmarks",
          os: ["linux"],
          sanitize: [rule],
        },
      ]),
    });
  });

  test("detectLinkedPaths: true becomes scanLinks true", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/windows/shell/.bashrc",
        localPath: "~\\.bashrc",
        platform: "windows",
        detectLinkedPaths: true,
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "shell/.bashrc",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.bashrc",
          os: ["windows"],
          scanLinks: true,
        },
      ]),
    });
  });

  test("keys: the list is copied unchanged", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/linux/gnome/dconf/input-sources.ini",
        platform: "linux",
        path: "/org/gnome/desktop/input-sources/",
        type: "dconf",
        keys: ["sources", "xkb-options"],
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "gnome/dconf/input-sources.ini",
          module: "unsorted",
          merge: "dconf",
          os: ["linux"],
          dconfPath: "/org/gnome/desktop/input-sources/",
          keys: ["sources", "xkb-options"],
        },
      ]),
    });
  });

  test("path: the dconf path becomes dconfPath", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/linux/gnome/dconf/shell.ini",
        platform: "linux",
        path: "/org/gnome/shell/",
        type: "dconf",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "gnome/dconf/shell.ini",
          module: "unsorted",
          merge: "dconf",
          os: ["linux"],
          dconfPath: "/org/gnome/shell/",
        },
      ]),
    });
  });

  test("three .gitconfig.local entries become one entry with no os", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/windows/git/.gitconfig.local",
        localPath: "~\\.gitconfig.local",
        platform: "windows",
        description: "Git credentials",
      },
      {
        repoPath: "dotfiles/linux/git/.gitconfig.local",
        localPath: "~/.gitconfig.local",
        platform: "linux",
        description: "Git credentials",
      },
      {
        repoPath: "dotfiles/macos/git/.gitconfig.local",
        localPath: "~/.gitconfig.local",
        platform: "macos",
        description: "Git credentials",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "git/.gitconfig.local",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.gitconfig.local",
          description: "Git credentials",
        },
      ]),
    });
  });

  test("entries with different local paths stay separate, each with os", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/windows/shell/.bashrc",
        localPath: "~\\.bashrc",
        platform: "windows",
        description: "Bash run commands",
      },
      {
        repoPath: "dotfiles/linux/shell/.bashrc",
        localPath: "~/.config/bash/.bashrc",
        platform: "linux",
        description: "Bash run commands",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "shell/.bashrc",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.bashrc",
          os: ["windows"],
          description: "Bash run commands",
        },
        {
          file: "shell/.bashrc",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.config/bash/.bashrc",
          os: ["linux"],
          description: "Bash run commands",
        },
      ]),
    });
  });

  test("a list of systems under the base root keeps its os", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/tmux/.tmux.conf",
        localPath: "~/.tmux.conf",
        platform: ["linux", "macos"],
        description: "tmux configuration",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "tmux/.tmux.conf",
          module: "unsorted",
          merge: "whole",
          localPath: "~/.tmux.conf",
          os: ["linux", "macos"],
          description: "tmux configuration",
        },
      ]),
    });
  });

  test("a list of systems under an OS root fails", () => {
    // Arrange
    const repoPath = "dotfiles/linux/tmux/.tmux.conf";
    const files: readonly ConfigV1Entry[] = [
      { repoPath, localPath: "~/.tmux.conf", platform: ["linux", "macos"] },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual(noRootError(repoPath));
  });

  test("a single system under the base root fails", () => {
    // Arrange
    const repoPath = "dotfiles/common/shell/.bashrc";
    const files: readonly ConfigV1Entry[] = [
      { repoPath, localPath: "~/.bashrc", platform: "linux" },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual(noRootError(repoPath));
  });

  test("a repoPath outside the layer roots fails", () => {
    // Arrange
    const repoPath = "dotfiles/other/x";
    const files: readonly ConfigV1Entry[] = [
      { repoPath, localPath: "~/.x", platform: "common" },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual(noRootError(repoPath));
  });

  test("a leading ~\\ and inner backslashes are rewritten", () => {
    // Arrange
    const files: readonly ConfigV1Entry[] = [
      {
        repoPath: "dotfiles/common/parity/backslash.conf",
        localPath: "~\\AppData\\Local\\app\\config",
        localPaths: { windows: "~\\AppData\\Roaming\\app\\config" },
        platform: "common",
      },
    ];

    // Act
    const result = convert(files);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: expected([
        {
          file: "parity/backslash.conf",
          module: "unsorted",
          merge: "whole",
          localPath: "~/AppData/Local/app/config",
          localPaths: { windows: "~/AppData/Roaming/app/config" },
        },
      ]),
    });
  });

  test("the repo's own sync-config.json converts and passes parseV2", () => {
    // Arrange
    const text = readFileSync(new URL("../../../sync-config.json", import.meta.url), "utf8");
    const parsed = parseV1(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    // Act
    const result = convertV1(parsed.value);

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(parseV2(JSON.stringify(result.value))).toEqual({ ok: true, value: result.value });
  });
});
