import { describe, expect, test } from "bun:test";
import { parseV1, validateOnlyPath } from "./v1.ts";

const CONFIG_FILE = "sync-config.json";

const SAFE_ENTRY = {
  repoPath: "dotfiles/common/parity/ok.conf",
  localPath: "~/.config/parity/ok.conf",
  platform: "common",
};

const DCONF_PATH = "/org/gnome/shell/";

function platformError(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} needs "platform": "common", "windows", "linux", "macos" or a list of the last three.`;
}

function unsafePathError(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} has an unsafe path.`;
}

function unknownKeyError(repoPath: string, key: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} has an unknown localPaths key ${key}.`;
}

function dconfPathError(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} needs "platform": "linux" and a dconf path like /org/gnome/shell/.`;
}

function defaultEnvError(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} has an invalid defaultEnv.`;
}

function configWith(files: readonly unknown[]): string {
  return JSON.stringify({ version: 1, excludePatterns: [], files });
}

function expectConfigError(files: readonly unknown[], message: string): void {
  // Act
  const result = parseV1(configWith(files));

  // Assert
  expect(result).toEqual({ ok: false, error: { message, code: 1 } });
}

describe("parseV1", () => {
  test("platform-missing: an entry without a platform stops with exit 1", () => {
    // Arrange
    const bad = {
      repoPath: "dotfiles/common/parity/bad.conf",
      localPath: "~/.config/parity/bad.conf",
    };

    // Act / Assert
    expectConfigError([SAFE_ENTRY, bad], platformError(bad.repoPath));
  });

  test("an entry with a platform outside the four stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, platform: "freebsd" };

    // Act / Assert
    expectConfigError([bad], platformError(bad.repoPath));
  });

  test("an empty platform list stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, platform: [] };

    // Act / Assert
    expectConfigError([bad], platformError(bad.repoPath));
  });

  test("a platform list with a repeated system stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, platform: ["linux", "linux"] };

    // Act / Assert
    expectConfigError([bad], platformError(bad.repoPath));
  });

  test("a platform list holding common stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, platform: ["common"] };

    // Act / Assert
    expectConfigError([bad], platformError(bad.repoPath));
  });

  test("a platform list of system names is accepted", () => {
    // Arrange
    const entry = {
      ...SAFE_ENTRY,
      platform: ["linux", "macos"],
      localPaths: { macos: "~/Library/parity/ok.conf" },
    };

    // Act
    const result = parseV1(configWith([entry]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("the platform check runs before the path checks", () => {
    // Arrange
    const bad = { repoPath: "dotfiles/common/../x.conf", localPath: "/tmp/x.conf" };

    // Act / Assert
    expectConfigError([bad], platformError(bad.repoPath));
  });

  test("repo-path-dotdot: a repoPath with a .. segment stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, repoPath: "dotfiles/common/../x.conf" };

    // Act / Assert
    expectConfigError([SAFE_ENTRY, bad], unsafePathError(bad.repoPath));
  });

  test("a repoPath outside dotfiles/ stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, repoPath: "common/parity/ok.conf" };

    // Act / Assert
    expectConfigError([bad], unsafePathError(bad.repoPath));
  });

  test("local-path-absolute: an absolute localPath stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, localPath: "/tmp/parity-x.conf" };

    // Act / Assert
    expectConfigError([SAFE_ENTRY, bad], unsafePathError(bad.repoPath));
  });

  test("a localPath with a .. segment stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, localPath: "~/../parity-x.conf" };

    // Act / Assert
    expectConfigError([bad], unsafePathError(bad.repoPath));
  });

  test("a non-dconf entry with no localPath stops with exit 1", () => {
    // Arrange
    const bad = { repoPath: SAFE_ENTRY.repoPath, platform: "common" };

    // Act / Assert
    expectConfigError([bad], unsafePathError(bad.repoPath));
  });

  test("localpaths-bad-key: an unknown localPaths key stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, localPaths: { freebsd: "~/.config/parity/ok.conf" } };

    // Act / Assert
    expectConfigError([SAFE_ENTRY, bad], unknownKeyError(bad.repoPath, "freebsd"));
  });

  test("a localPaths value that is not a ~/ or ~\\ path stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, localPaths: { macos: "/tmp/parity-x.conf" } };

    // Act / Assert
    expectConfigError([bad], unsafePathError(bad.repoPath));
  });

  test("a localPaths value with a .. segment stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, localPaths: { macos: "~/../parity-x.conf" } };

    // Act / Assert
    expectConfigError([bad], unsafePathError(bad.repoPath));
  });

  test("a localPaths that is not an object stops with exit 1", () => {
    // Arrange
    const bad = { ...SAFE_ENTRY, localPaths: ["~/.config/parity/ok.conf"] };

    // Act / Assert
    expectConfigError([bad], unsafePathError(bad.repoPath));
  });

  test("dconf-path-no-slash: a dconf path without leading and trailing slashes stops with exit 1", () => {
    // Arrange
    const bad = {
      repoPath: "dotfiles/linux/parity/test.ini",
      type: "dconf",
      platform: "linux",
      path: "org/parity/",
    };

    // Act / Assert
    expectConfigError([SAFE_ENTRY, bad], dconfPathError(bad.repoPath));
  });

  test("a dconf entry whose platform is a list stops with exit 1", () => {
    // Arrange
    const bad = {
      repoPath: "dotfiles/linux/parity/test.ini",
      type: "dconf",
      platform: ["linux"],
      path: DCONF_PATH,
    };

    // Act / Assert
    expectConfigError([bad], dconfPathError(bad.repoPath));
  });

  test("a dconf path with a .. segment stops with exit 1", () => {
    // Arrange
    const bad = {
      repoPath: "dotfiles/linux/parity/test.ini",
      type: "dconf",
      platform: "linux",
      path: "/org/../parity/",
    };

    // Act / Assert
    expectConfigError([bad], dconfPathError(bad.repoPath));
  });

  test("a dconf path of / alone stops with exit 1", () => {
    // Arrange
    const bad = {
      repoPath: "dotfiles/linux/parity/test.ini",
      type: "dconf",
      platform: "linux",
      path: "/",
    };

    // Act / Assert
    expectConfigError([bad], dconfPathError(bad.repoPath));
  });

  test("defaultenv-invalid: an invalid defaultEnv name stops with exit 1", () => {
    // Arrange
    const bad = {
      ...SAFE_ENTRY,
      sanitizeRules: [{ placeholder: "<YOUR_NAME>", prompt: "Full name", defaultEnv: "1BAD" }],
    };

    // Act / Assert
    expectConfigError([bad], defaultEnvError(bad.repoPath));
  });

  test("a valid defaultEnv name is accepted", () => {
    // Arrange
    const entry = {
      ...SAFE_ENTRY,
      sanitizeRules: [{ placeholder: "<HOME>", prompt: "Home folder", defaultEnv: "HOME" }],
    };

    // Act
    const result = parseV1(configWith([entry]));

    // Assert
    expect(result.ok).toBe(true);
  });

  test("invalid JSON is rejected with exit 1", () => {
    // Act
    const result = parseV1("{ not json");

    // Assert
    expect(result).toEqual({
      ok: false,
      error: { message: `ERROR: ${CONFIG_FILE}: invalid JSON.`, code: 1 },
    });
  });

  test("a config whose files is not a list is rejected", () => {
    // Arrange
    const text = JSON.stringify({ version: 1, files: {} });

    // Act
    const result = parseV1(text);

    // Assert
    expect(result).toEqual({
      ok: false,
      error: { message: `ERROR: ${CONFIG_FILE}: invalid JSON.`, code: 1 },
    });
  });

  test("a valid config with one entry of each entry type parses ok", () => {
    // Arrange
    const text = JSON.stringify({
      version: 1,
      defaultUser: null,
      excludePatterns: ["*.bak"],
      files: [
        {
          repoPath: "dotfiles/common/editorconfig/.editorconfig",
          localPath: "~/.editorconfig",
          platform: "common",
          description: "Editor defaults",
          type: "file",
        },
        {
          repoPath: "dotfiles/linux/nvim",
          localPath: "~/.config/nvim",
          platform: "linux",
          description: "Neovim configuration",
          type: "dir",
        },
        {
          repoPath: "dotfiles/linux/gnome/dconf/shell.ini",
          platform: "linux",
          description: "GNOME shell settings",
          type: "dconf",
          path: DCONF_PATH,
          keys: ["favorite-apps"],
        },
      ],
    });

    // Act
    const result = parseV1(text);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.map((entry) => entry.type)).toEqual(["file", "dir", "dconf"]);
    }
  });
});

describe("validateOnlyPath", () => {
  test("only-dotdot: a repo path with a .. segment is refused", () => {
    // Arrange
    const path = "dotfiles/common/../x";

    // Act
    const result = validateOnlyPath(path);

    // Assert
    expect(result).toEqual({
      ok: false,
      error: { message: `ERROR: ${path} is not synced on this machine.`, code: 1 },
    });
  });

  test("a repo path without a .. segment is accepted", () => {
    // Arrange
    const path = "dotfiles/common/parity/a.conf";

    // Act
    const result = validateOnlyPath(path);

    // Assert
    expect(result).toEqual({ ok: true, value: path });
  });

  test("a local path with a .. segment is accepted", () => {
    // Arrange
    const path = "~/.config/../parity/a.conf";

    // Act
    const result = validateOnlyPath(path);

    // Assert
    expect(result).toEqual({ ok: true, value: path });
  });
});
