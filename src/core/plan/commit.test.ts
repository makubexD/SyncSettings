import { describe, expect, test } from "bun:test";
import type { Os } from "../config/types.ts";
import {
  branchName,
  cachedValueHits,
  firstKnownValueHit,
  hostnameHits,
  checkAlias,
  commitMessage,
  outsidePaths,
  prBody,
  suggestAlias,
} from "./commit.ts";
import type { SyncFileContent } from "./commit.ts";

const LINUX: Os = "linux";

const WINDOWS: Os = "windows";

const MACHINE = "wk1-laptop";

const STAMP = "20261114-1804";

const USER_MESSAGE = "chore: a hand-written message";

const EMAIL_PLACEHOLDER = "<YOUR_EMAIL>";

const EMAIL_VALUE = "jane@work1.example.com";

const UPPER_EMAIL_VALUE = "JANE@WORK1.EXAMPLE.COM";

const PATH_PLACEHOLDER = "<WORK_PATH>";

/** A Windows path, the value that must be found raw and backslash-doubled. */
const BACKSLASH_VALUE = String.raw`C:\Users\jdoe`;

const MODIFIED_GITCONFIG = " M dotfiles/common/git/.gitconfig";

const ADDED_SETTINGS = "?? dotfiles/linux/vscode/settings.json";

const DELETED_OLD = " D dotfiles/common/old.conf";

const RENAME_INSIDE = "R  dotfiles/common/a -> dotfiles/common/b";

const OUTSIDE_CONFIG_DIR = "?? .config/";

const OUTSIDE_README = " M README.md";

const OUTSIDE_NOTES = " D notes.txt";

const PACKAGES_FILE = "?? packages/extra/p.conf";

const PACKAGES_DIR = "?? packages/";

const CONFIG_FILE_LINE = "A  sync-config.json";

const QUOTED_OUTSIDE = String.raw`?? "my folder/file.conf"`;

const QUOTED_INSIDE = String.raw`?? "dotfiles/my folder/file.conf"`;

const QUOTED_OCTAL_OUTSIDE = String.raw`?? "caf\303\251.conf"`;

const QUOTED_OCTAL_INSIDE = String.raw`?? "dotfiles/caf\303\251.conf"`;

/** A NetBIOS-style hostname and the alias it becomes. */
const NETBIOS_HOSTNAME = "WORK_PC01";

const NETBIOS_ALIAS = "work-pc01";

const SHORT_HOSTNAME = "wk1-laptop";

const FQDN_HOSTNAME = "wk1-laptop.example.com";

const VALID_ALIAS = "jane-doe";

function porcelainOf(...lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function filesOf(
  entries: readonly (readonly [string, SyncFileContent])[],
): ReadonlyMap<string, SyncFileContent> {
  return new Map(entries);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("branchName", () => {
  test("should build commit.sh's branch name for the OS, machine and stamp", () => {
    // Arrange

    // Act
    const branch = branchName(LINUX, MACHINE, STAMP);

    // Assert
    expect(branch).toBe(`sync/linux-${MACHINE}-${STAMP}`);
  });

  test("should use the OS as given for a Windows machine", () => {
    // Arrange

    // Act
    const branch = branchName(WINDOWS, MACHINE, STAMP);

    // Assert
    expect(branch).toBe(`sync/windows-${MACHINE}-${STAMP}`);
  });

  test("should refuse a machine alias commit.sh rejects", () => {
    // Arrange
    const invalid = ["Wk1", "-laptop", "a b", "a".repeat(25)];

    // Act / Assert
    for (const machine of invalid) {
      expect(() => branchName(LINUX, machine, STAMP)).toThrow(RangeError);
    }
  });
});

describe("suggestAlias", () => {
  test.each<[string, Os, string]>([
    ["work2", WINDOWS, "work2-windows"],
    ["personal", LINUX, "personal-linux"],
    ["Work_2", WINDOWS, "work-2-windows"],
    ["日本", LINUX, "linux"],
    ["", LINUX, "linux"],
  ])("should suggest %p on %p as %p", (profile, os, expected) => {
    expect(suggestAlias(profile, os, SHORT_HOSTNAME)).toBe(expected);
  });

  test("should suggest nothing when <profile>-<os> is the hostname", () => {
    expect(suggestAlias("wk1", LINUX, "WK1-Linux.example.com")).toBeUndefined();
  });

  test("should suggest nothing when the profile makes it too long", () => {
    expect(
      suggestAlias("a".repeat(20), WINDOWS, SHORT_HOSTNAME),
    ).toBeUndefined();
  });
});

describe("checkAlias", () => {
  test("should refuse the hostname or its short form, ignoring case", () => {
    // Arrange
    const record = { hostname: FQDN_HOSTNAME };

    // Act
    const result = checkAlias("WK1-LAPTOP", record);

    // Assert
    expect(result).toEqual({
      error: `ERROR: 'WK1-LAPTOP' is this machine's hostname; pick another public name.`,
    });
  });

  test("should refuse the hostname once both are in alias form", () => {
    // Arrange
    const record = { hostname: NETBIOS_HOSTNAME };

    // Act
    const result = checkAlias(NETBIOS_ALIAS, record);

    // Assert
    expect(result).toEqual({
      error: `ERROR: '${NETBIOS_ALIAS}' is this machine's hostname; pick another public name.`,
    });
  });

  test("should refuse a name that is not a valid alias", () => {
    // Arrange
    const record = { hostname: SHORT_HOSTNAME };

    // Act
    const result = checkAlias("a b", record);

    // Assert
    expect(result).toEqual({
      error: `ERROR: invalid machine alias 'a b' (use a-z, 0-9, -).`,
    });
  });

  test("should accept a valid name that is not the hostname", () => {
    // Arrange
    const record = { hostname: SHORT_HOSTNAME };

    // Act
    const result = checkAlias(VALID_ALIAS, record);

    // Assert
    expect(result).toEqual({ alias: VALID_ALIAS });
  });
});

describe("commitMessage", () => {
  test("should keep a message given with -m", () => {
    // Arrange
    const statusLines = [MODIFIED_GITCONFIG];

    // Act
    const message = commitMessage(USER_MESSAGE, statusLines);

    // Assert
    expect(message).toBe(USER_MESSAGE);
  });

  test("should build the default message from the status lines when none is given", () => {
    // Arrange
    const statusLines = [MODIFIED_GITCONFIG, ADDED_SETTINGS, DELETED_OLD];

    // Act
    const message = commitMessage(undefined, statusLines);

    // Assert
    expect(message).toBe(
      "sync: add settings.json; update .gitconfig; remove old.conf",
    );
  });

  test("should treat an empty -m as no message", () => {
    // Arrange
    const statusLines = [ADDED_SETTINGS];

    // Act
    const message = commitMessage("", statusLines);

    // Assert
    expect(message).toBe("sync: add settings.json");
  });

  test("should name only the base name of each file", () => {
    // Arrange
    const statusLines = ["A  dotfiles/common/git/.gitconfig"];

    // Act
    const message = commitMessage(undefined, statusLines);

    // Assert
    expect(message).toBe("sync: add .gitconfig");
  });

  test("should shorten the default message past 72 characters", () => {
    // Arrange
    const statusLines = [
      "?? dotfiles/common/very-long-file-name-number-one.conf",
      "?? dotfiles/common/very-long-file-name-number-two.conf",
    ];

    // Act
    const message = commitMessage(undefined, statusLines);

    // Assert
    expect(message).toBe("sync: update 2 config file(s)");
  });

  test("should fall back to the generic message when no line classifies", () => {
    // Arrange
    const statusLines = [RENAME_INSIDE, "??"];

    // Act
    const message = commitMessage(undefined, statusLines);

    // Assert
    expect(message).toBe("sync: update config files");
  });
});

describe("prBody", () => {
  test("should list the status lines and name the OS and machine", () => {
    // Arrange
    const statusLines = [MODIFIED_GITCONFIG, ADDED_SETTINGS];

    // Act
    const body = prBody(statusLines, LINUX, MACHINE, undefined);

    // Assert
    expect(body).toBe(
      `## What changed\n\n- \`${MODIFIED_GITCONFIG}\`\n- \`${ADDED_SETTINGS}\`\n\nPlatform: linux · Machine: ${MACHINE}\n\nWhen the review is done, add the **\`reviewed\`** label.\n`,
    );
  });

  test("should add a Profile line after the machine line when a profile is given", () => {
    // Arrange
    const profile = "work-1";

    // Act
    const body = prBody([MODIFIED_GITCONFIG], LINUX, MACHINE, profile);

    // Assert
    expect(body).toContain(
      `Platform: linux · Machine: ${MACHINE}\nProfile: ${profile}\n`,
    );
  });

  test("should name the OS as given", () => {
    // Arrange

    // Act
    const body = prBody([MODIFIED_GITCONFIG], WINDOWS, MACHINE, undefined);

    // Assert
    expect(body).toContain(`Platform: windows · Machine: ${MACHINE}`);
  });
});

describe("outsidePaths", () => {
  test("should return nothing when every path is a sync path", () => {
    // Arrange
    const porcelain = porcelainOf(
      MODIFIED_GITCONFIG,
      CONFIG_FILE_LINE,
      PACKAGES_FILE,
    );

    // Act
    const outside = outsidePaths(porcelain, true);

    // Assert
    expect(outside).toEqual([]);
  });

  test("should return each line whose path is outside the sync paths", () => {
    // Arrange
    const porcelain = porcelainOf(
      MODIFIED_GITCONFIG,
      OUTSIDE_CONFIG_DIR,
      OUTSIDE_README,
      OUTSIDE_NOTES,
    );

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual([
      OUTSIDE_CONFIG_DIR,
      OUTSIDE_README,
      OUTSIDE_NOTES,
    ]);
  });

  test("should accept packages/ only when the folder exists", () => {
    // Arrange
    const porcelain = porcelainOf(PACKAGES_DIR, PACKAGES_FILE);

    // Act
    const withFolder = outsidePaths(porcelain, true);
    const withoutFolder = outsidePaths(porcelain, false);

    // Assert
    expect(withFolder).toEqual([]);
    expect(withoutFolder).toEqual([PACKAGES_DIR, PACKAGES_FILE]);
  });

  test("should accept only the config file itself, not its neighbours", () => {
    // Arrange
    const neighbours = [
      "?? sync-config.json.bak",
      "?? other/sync-config.json",
      "?? sync-config.v2.json",
    ];
    const porcelain = porcelainOf(CONFIG_FILE_LINE, ...neighbours);

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual(neighbours);
  });

  test("should count a rename as outside when either side is", () => {
    // Arrange
    const porcelain = porcelainOf(
      RENAME_INSIDE,
      "R  dotfiles/common/a -> README.md",
      "R  notes.txt -> dotfiles/common/a",
    );

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual([
      "R  dotfiles/common/a -> README.md",
      "R  notes.txt -> dotfiles/common/a",
    ]);
  });

  test("should read a quoted path as git quoted it", () => {
    // Arrange
    const porcelain = porcelainOf(QUOTED_OUTSIDE, QUOTED_INSIDE);

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual([QUOTED_OUTSIDE]);
  });

  test("should read a non-ASCII path from its octal escapes", () => {
    // Arrange
    const porcelain = porcelainOf(QUOTED_OCTAL_OUTSIDE, QUOTED_OCTAL_INSIDE);

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual([QUOTED_OCTAL_OUTSIDE]);
  });

  test("should read both sides of a quoted rename", () => {
    // Arrange
    const outsideRename = String.raw`R  "dotfiles/old name" -> "new name"`;
    const insideRename = String.raw`R  "dotfiles/old name" -> "dotfiles/new name"`;
    const porcelain = porcelainOf(outsideRename, insideRename);

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual([outsideRename]);
  });

  test("should ignore empty lines", () => {
    // Arrange
    const porcelain = porcelainOf();

    // Act
    const outside = outsidePaths(porcelain, false);

    // Assert
    expect(outside).toEqual([]);
  });
});

describe("cachedValueHits", () => {
  test("should return nothing without values", () => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", EMAIL_VALUE]]);

    // Act
    const hits = cachedValueHits(files, {});

    // Assert
    expect(hits).toEqual([]);
  });

  test("should skip an empty value", () => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", "anything"]]);

    // Act
    const hits = cachedValueHits(files, { [EMAIL_PLACEHOLDER]: "" });

    // Assert
    expect(hits).toEqual([]);
  });

  test("should let a placeholder on its own pass", () => {
    // Arrange
    const files = filesOf([
      ["dotfiles/a.conf", `email=${EMAIL_PLACEHOLDER}\n`],
    ]);
    const values = { [EMAIL_PLACEHOLDER]: EMAIL_PLACEHOLDER };

    // Act
    const hits = cachedValueHits(files, values);

    // Assert
    expect(hits).toEqual([]);
  });

  test("should find a value ignoring case", () => {
    // Arrange
    const files = filesOf([
      ["dotfiles/a.conf", `email=${UPPER_EMAIL_VALUE}\n`],
    ]);

    // Act
    const hits = cachedValueHits(files, { [EMAIL_PLACEHOLDER]: EMAIL_VALUE });

    // Assert
    expect(hits).toEqual([
      { placeholder: EMAIL_PLACEHOLDER, file: "dotfiles/a.conf" },
    ]);
  });

  test("should find the value with single backslashes", () => {
    // Arrange
    const files = filesOf([
      ["dotfiles/a.conf", String.raw`path=${BACKSLASH_VALUE}`],
    ]);

    // Act
    const hits = cachedValueHits(files, {
      [PATH_PLACEHOLDER]: BACKSLASH_VALUE,
    });

    // Assert
    expect(hits).toEqual([
      { placeholder: PATH_PLACEHOLDER, file: "dotfiles/a.conf" },
    ]);
  });

  test("should find the backslash-doubled form", () => {
    // Arrange
    const doubled = String.raw`C:\\Users\\jdoe`;
    const files = filesOf([["dotfiles/a.conf", `path=${doubled}`]]);

    // Act
    const hits = cachedValueHits(files, {
      [PATH_PLACEHOLDER]: BACKSLASH_VALUE,
    });

    // Assert
    expect(hits).toEqual([
      { placeholder: PATH_PLACEHOLDER, file: "dotfiles/a.conf" },
    ]);
  });

  test("should read the bytes an adapter read", () => {
    // Arrange
    const files = filesOf([
      ["dotfiles/a.conf", bytesOf(`email=${EMAIL_VALUE}\n`)],
    ]);

    // Act
    const hits = cachedValueHits(files, { [EMAIL_PLACEHOLDER]: EMAIL_VALUE });

    // Assert
    expect(hits).toEqual([
      { placeholder: EMAIL_PLACEHOLDER, file: "dotfiles/a.conf" },
    ]);
  });

  test("should list placeholders sorted and each matching file once", () => {
    // Arrange
    const alphaPlaceholder = "<A_PLACEHOLDER>";
    const betaPlaceholder = "<B_PLACEHOLDER>";
    const files = filesOf([
      ["dotfiles/one.conf", "alpha beta"],
      ["dotfiles/two.conf", "ALPHA"],
    ]);
    const values = { [betaPlaceholder]: "beta", [alphaPlaceholder]: "alpha" };

    // Act
    const hits = cachedValueHits(files, values);

    // Assert
    expect(hits).toEqual([
      { placeholder: alphaPlaceholder, file: "dotfiles/one.conf" },
      { placeholder: alphaPlaceholder, file: "dotfiles/two.conf" },
      { placeholder: betaPlaceholder, file: "dotfiles/one.conf" },
    ]);
  });

  test("should never return the value", () => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", `email=${EMAIL_VALUE}\n`]]);

    // Act
    const hits = cachedValueHits(files, { [EMAIL_PLACEHOLDER]: EMAIL_VALUE });

    // Assert
    expect(JSON.stringify(hits)).not.toContain(EMAIL_VALUE);
  });
});

describe("hostnameHits", () => {
  const HOSTNAME = "parity-host.corp.example";

  test.each([
    ["the full name", "server parity-host.corp.example\n"],
    ["the short name", "server parity-host\n"],
    ["a different case", "server PARITY-HOST\n"],
  ])("should find %s as a whole word", (_label, text) => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", text]]);

    // Act
    const hits = hostnameHits(files, HOSTNAME);

    // Assert
    expect(hits).toEqual(["dotfiles/a.conf"]);
  });

  test.each([
    ["a longer name", "server parity-hostess\n"],
    ["a prefixed name", "server my-parity-host\n"],
  ])("should not find the hostname inside %s", (_label, text) => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", text]]);

    // Act
    const hits = hostnameHits(files, HOSTNAME);

    // Assert
    expect(hits).toEqual([]);
  });

  test("should find nothing without a hostname", () => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", "server parity-host\n"]]);

    // Act
    const hits = hostnameHits(files, undefined);

    // Assert
    expect(hits).toEqual([]);
  });
});

describe("firstKnownValueHit", () => {
  test("should report a cached value before the hostname", () => {
    // Arrange
    const files = filesOf([
      ["dotfiles/a.conf", "server parity-host\n"],
      ["dotfiles/b.conf", `email=${EMAIL_VALUE}\n`],
    ]);

    // Act
    const hit = firstKnownValueHit(
      files,
      { [EMAIL_PLACEHOLDER]: EMAIL_VALUE },
      "parity-host",
    );

    // Assert
    expect(hit).toEqual({
      kind: "value",
      placeholder: EMAIL_PLACEHOLDER,
      file: "dotfiles/b.conf",
    });
  });

  test("should report the hostname when no cached value is found", () => {
    // Arrange
    const files = filesOf([["dotfiles/a.conf", "server parity-host\n"]]);

    // Act
    const hit = firstKnownValueHit(files, {}, "parity-host");

    // Assert
    expect(hit).toEqual({ kind: "hostname", file: "dotfiles/a.conf" });
  });
});
