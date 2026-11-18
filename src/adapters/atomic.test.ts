import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SymlinkRefusal, writeAtomic } from "./atomic.ts";

const PRIVATE_MODE = 0o600;

const READABLE_MODE = 0o644;

const OLD_TEXT = "old\n";

const NEW_TEXT = "new\n";

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-atomic-"));
  tempFolders.push(folder);
  return folder;
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

function writeFixture(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode === undefined ? {} : { mode });
}

/** The temp file a write under `path` makes for this process. */
function tempFileOf(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
}

describe("writeAtomic", () => {
  test.skipIf(process.platform === "win32")(
    "should write a new file readable by the current user only",
    () => {
      // Arrange
      const path = join(tempFolder(), "values.json");

      // Act
      writeAtomic(path, NEW_TEXT, PRIVATE_MODE);

      // Assert
      expect(readFileSync(path, "utf8")).toBe(NEW_TEXT);
      expect(statSync(path).mode & 0o777).toBe(PRIVATE_MODE);
    },
  );

  test.skipIf(process.platform === "win32")(
    "should tighten an existing readable file when it writes it",
    () => {
      // Arrange
      const path = join(tempFolder(), "values.json");
      writeFixture(path, OLD_TEXT, READABLE_MODE);

      // Act
      writeAtomic(path, NEW_TEXT, PRIVATE_MODE);

      // Assert
      expect(readFileSync(path, "utf8")).toBe(NEW_TEXT);
      expect(statSync(path).mode & 0o777).toBe(PRIVATE_MODE);
    },
  );

  test.skipIf(process.platform === "win32")(
    "should hold the new text in a private temp file before the rename",
    () => {
      // Arrange
      const path = join(tempFolder(), "values.json");
      writeFixture(path, OLD_TEXT, READABLE_MODE);
      let tempText: string | undefined;
      let tempMode: number | undefined;
      let targetBeforeRename: string | undefined;
      const deps = {
        rename: (from: string, to: string): void => {
          tempText = readFileSync(from, "utf8");
          tempMode = statSync(from).mode & 0o777;
          targetBeforeRename = readFileSync(to, "utf8");
          renameSync(from, to);
        },
      };

      // Act
      writeAtomic(path, NEW_TEXT, PRIVATE_MODE, deps);

      // Assert
      expect(tempText).toBe(NEW_TEXT);
      expect(tempMode).toBe(PRIVATE_MODE);
      expect(targetBeforeRename).toBe(OLD_TEXT);
      expect(readFileSync(path, "utf8")).toBe(NEW_TEXT);
    },
  );

  test("should refuse a symlink and leave its target unchanged", () => {
    // Arrange
    const folder = tempFolder();
    const target = join(folder, "target.json");
    writeFixture(target, OLD_TEXT);
    const link = join(folder, "values.json");
    symlinkSync(target, link);

    // Act
    const refusal = (): void => {
      writeAtomic(link, NEW_TEXT, PRIVATE_MODE);
    };

    // Assert
    expect(refusal).toThrow(SymlinkRefusal);
    expect(refusal).toThrow(`ERROR: ${link} is a symlink.`);
    expect(readFileSync(target, "utf8")).toBe(OLD_TEXT);
    expect(existsSync(tempFileOf(link))).toBe(false);
  });

  test("should leave the old file and no temp file when the rename fails", () => {
    // Arrange
    const folder = tempFolder();
    const path = join(folder, "values.json");
    writeFixture(path, OLD_TEXT, READABLE_MODE);
    const deps = {
      rename: (): void => {
        throw new Error("rename failed");
      },
    };

    // Act
    const failing = (): void => {
      writeAtomic(path, NEW_TEXT, PRIVATE_MODE, deps);
    };

    // Assert
    expect(failing).toThrow("rename failed");
    expect(readFileSync(path, "utf8")).toBe(OLD_TEXT);
    expect(readdirSync(folder)).toEqual([basename(path)]);
  });

  test("should write bytes as well as text", () => {
    // Arrange
    const path = join(tempFolder(), "values.json");
    const bytes = new TextEncoder().encode(NEW_TEXT);

    // Act
    writeAtomic(path, bytes, PRIVATE_MODE);

    // Assert
    expect(readFileSync(path, "utf8")).toBe(NEW_TEXT);
  });
});
