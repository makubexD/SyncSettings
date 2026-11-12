import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShadowLog } from "./engine.ts";

const STAMP = "2026-11-12T10:00:00.000Z";

function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), "mksync-shadow-test-"));
}

describe("appendShadowLog", () => {
  test("should append the given text to the state folder", () => {
    // Arrange
    const parent = tempFolder();
    const stateFolder = join(parent, "sync-settings");
    const logText =
      `${STAMP} import a: program ADDED, engine nothing\n` +
      `${STAMP} export b: only in engine\n`;

    try {
      // Act
      appendShadowLog(stateFolder, logText);

      // Assert
      expect(readFileSync(join(stateFolder, "shadow.log"), "utf8")).toBe(logText);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("should write nothing when there is no log text", () => {
    // Arrange
    const parent = tempFolder();
    const stateFolder = join(parent, "sync-settings");

    try {
      // Act
      appendShadowLog(stateFolder, "");

      // Assert
      expect(existsSync(join(stateFolder, "shadow.log"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
