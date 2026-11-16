import { describe, expect, test } from "bun:test";
import type { LinkedEntry } from "./linked.ts";
import {
  linkedFolders,
  MAX_LINKED_BYTES,
  MAX_LINKED_FILES,
  suggestLinked,
  unaskedFolders,
} from "./linked.ts";

const HOME = "/home/user";
const WINDOWS_HOME = "C:\\Users\\user";

function existing(paths: readonly string[]): (path: string) => boolean {
  const present = new Set(paths);
  return (path) => present.has(path);
}

function dirEntry(localPath: string): LinkedEntry {
  return { merge: "dir", localPath };
}

function alwaysExists(): boolean {
  return true;
}

describe("linkedFolders", () => {
  test("finds an MSYS-style drive folder", () => {
    // Arrange
    const text = "source /c/tools/scripts";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual(["/c/tools/scripts"]);
  });

  test("strips a glob suffix from an MSYS-style folder", () => {
    // Arrange
    const text = "alias ll='ls /c/tools/*.sh'";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual(["/c/tools"]);
  });

  test("finds a Windows drive folder without its trailing backslash", () => {
    // Arrange
    const text = 'export PATH="C:\\Tools\\bin\\:$PATH"';

    // Act
    const result = linkedFolders(text, WINDOWS_HOME);

    // Assert
    expect(result).toEqual(["C:\\Tools\\bin"]);
  });

  test("expands a ~ folder against the home", () => {
    // Arrange
    const text = "source ~/work-tool-1-scripts";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual([`${HOME}/work-tool-1-scripts`]);
  });

  test("expands a $HOME folder against the home", () => {
    // Arrange
    const text = 'PATH="$HOME/tools/bin:$PATH"';

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual([`${HOME}/tools/bin`]);
  });

  test("expands a %USERPROFILE% folder with the reference's separator", () => {
    // Arrange
    const text = 'set PATH=%USERPROFILE%\\tools\\bin;%PATH%';

    // Act
    const result = linkedFolders(text, WINDOWS_HOME);

    // Assert
    expect(result).toEqual(["C:\\Users\\user\\tools\\bin"]);
  });

  test("trims a trailing separator from a home folder", () => {
    // Arrange
    const text = "cd ~/tools/";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual([`${HOME}/tools`]);
  });

  test("removes duplicate folders", () => {
    // Arrange
    const text = "source ~/tools\necho ~/tools";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual([`${HOME}/tools`]);
  });

  test("keeps folders in first-seen order across pattern kinds", () => {
    // Arrange
    const text = "C:\\Tools ~/scripts /c/bin";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual(["C:\\Tools", `${HOME}/scripts`, "/c/bin"]);
  });

  test("returns nothing for text without folder references", () => {
    // Arrange
    const text = "echo hello";

    // Act
    const result = linkedFolders(text, HOME);

    // Assert
    expect(result).toEqual([]);
  });
});

describe("unaskedFolders", () => {
  test("returns an existing folder no entry syncs and nobody answered", () => {
    // Arrange
    const found = [`${HOME}/tools`];

    // Act
    const result = unaskedFolders(
      found,
      [dirEntry(`${HOME}/other`)],
      {},
      existing(found),
    );

    // Assert
    expect(result).toEqual(found);
  });

  test("drops a folder that does not exist", () => {
    // Arrange
    const found = [`${HOME}/missing`];

    // Act
    const result = unaskedFolders(found, [], {}, existing([]));

    // Assert
    expect(result).toEqual([]);
  });

  test("drops a folder a dir entry syncs exactly", () => {
    // Arrange
    const found = [`${HOME}/tools`];

    // Act
    const result = unaskedFolders(
      found,
      [dirEntry(`${HOME}/tools`)],
      {},
      alwaysExists,
    );

    // Assert
    expect(result).toEqual([]);
  });

  test("drops a folder inside a dir entry's local path", () => {
    // Arrange
    const found = [`${HOME}/tools/scripts`];

    // Act
    const result = unaskedFolders(
      found,
      [dirEntry(`${HOME}/tools`)],
      {},
      alwaysExists,
    );

    // Assert
    expect(result).toEqual([]);
  });

  test("compares local paths with either separator style", () => {
    // Arrange
    const found = ["C:\\Users\\user\\tools\\scripts"];

    // Act
    const result = unaskedFolders(
      found,
      [dirEntry("C:\\Users\\user\\tools")],
      {},
      alwaysExists,
    );

    // Assert
    expect(result).toEqual([]);
  });

  test("keeps a folder whose local path only a file entry names", () => {
    // Arrange
    const found = [`${HOME}/tools`];
    const entries: readonly LinkedEntry[] = [
      { merge: "whole", localPath: `${HOME}/tools` },
    ];

    // Act
    const result = unaskedFolders(found, entries, {}, alwaysExists);

    // Assert
    expect(result).toEqual(found);
  });

  test("drops a folder the profile answered linked: no", () => {
    // Arrange
    const folder = `${HOME}/tools`;
    const destinations = { [`linked: ${folder}`]: "no" };

    // Act
    const result = unaskedFolders([folder], [], destinations, alwaysExists);

    // Assert
    expect(result).toEqual([]);
  });

  test("keeps a folder answered under another key", () => {
    // Arrange
    const folder = `${HOME}/tools`;
    const destinations = { [`linked: ${HOME}/other`]: "no" };

    // Act
    const result = unaskedFolders([folder], [], destinations, alwaysExists);

    // Assert
    expect(result).toEqual([folder]);
  });

  test("keeps the found order", () => {
    // Arrange
    const found = [`${HOME}/b`, `${HOME}/a`];

    // Act
    const result = unaskedFolders(found, [], {}, alwaysExists);

    // Assert
    expect(result).toEqual(found);
  });
});

describe("suggestLinked", () => {
  test("suggests the profile for a small folder under the home", () => {
    // Act
    const result = suggestLinked(12, 40 * 1024, true);

    // Assert
    expect(result).toBe("profile");
  });

  test("suggests nothing at the file limit", () => {
    // Act
    const result = suggestLinked(MAX_LINKED_FILES, 0, true);

    // Assert
    expect(result).toBe("no");
  });

  test("suggests the profile just below the file limit", () => {
    // Act
    const result = suggestLinked(MAX_LINKED_FILES - 1, 0, true);

    // Assert
    expect(result).toBe("profile");
  });

  test("suggests nothing at the byte limit", () => {
    // Act
    const result = suggestLinked(0, MAX_LINKED_BYTES, true);

    // Assert
    expect(result).toBe("no");
  });

  test("suggests the profile just below the byte limit", () => {
    // Act
    const result = suggestLinked(0, MAX_LINKED_BYTES - 1, true);

    // Assert
    expect(result).toBe("profile");
  });

  test("suggests nothing outside the home", () => {
    // Act
    const result = suggestLinked(1, 1, false);

    // Assert
    expect(result).toBe("no");
  });
});
