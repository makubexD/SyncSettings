import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE } from "./parse.ts";
import { appendShadowLog, compareShadow, runShadow } from "./shadow.ts";
import type { ShadowResult } from "./shadow.ts";

const STAMP = "2026-11-12T10:00:00.000Z";

function shadowResult(
  checkLines: readonly string[],
  exported: Readonly<Record<string, string>> = {},
  previewLines: readonly string[] = [],
): ShadowResult {
  return { checkLines, previewLines, exported: new Map(Object.entries(exported)) };
}

function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), "mksync-shadow-test-"));
}

describe("compareShadow", () => {
  test("should report nothing when both sides match", () => {
    const lines = ["  UNCHANGED dotfiles/linux/shell/.bashrc"];
    const exported = { "dotfiles/linux/shell/.bashrc": "name=<YOUR_NAME>\n" };
    expect(
      compareShadow(shadowResult(lines, exported), shadowResult(lines, exported)),
    ).toEqual([]);
  });

  test("should report a differing status word as one line", () => {
    const program = shadowResult(["  UPDATED   dotfiles/linux/shell/.bashrc"]);
    const engine = shadowResult(["  UNCHANGED dotfiles/linux/shell/.bashrc"]);
    expect(compareShadow(program, engine)).toEqual([
      "import dotfiles/linux/shell/.bashrc: program UPDATED, engine UNCHANGED",
    ]);
  });

  test("should report a label only one side lists as one line", () => {
    const program = shadowResult([
      "  UNCHANGED dotfiles/linux/shell/.bashrc",
      "  ADDED     dotfiles/linux/shell/.profile",
    ]);
    const engine = shadowResult([
      "  UNCHANGED dotfiles/linux/shell/.bashrc",
    ]);
    expect(compareShadow(program, engine)).toEqual([
      "import dotfiles/linux/shell/.profile: program ADDED, engine nothing",
    ]);
  });

  test("should report differing placeholder sets as one line", () => {
    const path = "dotfiles/linux/git/.gitconfig";
    const program = shadowResult([], {
      [path]: "name = <YOUR_NAME>\nemail = <YOUR_EMAIL>\n",
    });
    const engine = shadowResult([], { [path]: "name = <YOUR_NAME>\n" });
    expect(compareShadow(program, engine)).toEqual([
      `export ${path}: placeholders differ (program <YOUR_EMAIL>,<YOUR_NAME>; engine <YOUR_NAME>)`,
    ]);
  });

  test("should compare preview words with the preview, not the check", () => {
    // Arrange
    const label = "dotfiles/linux/shell/.bashrc";
    const program = shadowResult([`  UPDATED ${label}`], {}, [`  UNCHANGED ${label}`]);
    const engine = shadowResult([`  UNCHANGED ${label}`], {}, [`  UPDATED ${label}`]);

    // Act
    const differences = compareShadow(program, engine);

    // Assert
    expect(differences).toEqual([
      `import ${label}: program UPDATED, engine UNCHANGED`,
      `export ${label}: program UNCHANGED, engine UPDATED`,
    ]);
  });

  test("should treat ANSI-coloured lines as equal to plain ones", () => {
    const plain = ["  UNCHANGED dotfiles/linux/shell/.bashrc"];
    const coloured = [
      "\u001b[1;32m  UNCHANGED dotfiles/linux/shell/.bashrc\u001b[0m",
    ];
    expect(
      compareShadow(shadowResult(plain), shadowResult(coloured)),
    ).toEqual([]);
  });
});

describe("appendShadowLog", () => {
  test("should append timestamped lines to the state folder", () => {
    const parent = tempFolder();
    const stateFolder = join(parent, "sync-settings");
    try {
      appendShadowLog(
        stateFolder,
        ["import a: program ADDED, engine nothing", "export b: only in engine"],
        () => new Date(STAMP),
      );
      expect(readFileSync(join(stateFolder, "shadow.log"), "utf8")).toBe(
        `${STAMP} import a: program ADDED, engine nothing\n` +
          `${STAMP} export b: only in engine\n`,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("should write nothing when there is no difference", () => {
    const parent = tempFolder();
    const stateFolder = join(parent, "sync-settings");
    try {
      appendShadowLog(stateFolder, []);
      expect(existsSync(join(stateFolder, "shadow.log"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("runShadow", () => {
  test("should print shadow: same and exit 0 when both sides match", async () => {
    const stateFolder = join(tempFolder(), "sync-settings");
    const outcome = await runShadow({
      stateFolder,
      program: () => shadowResult([]),
      engine: async () => shadowResult([]),
    });
    expect(outcome).toEqual({ code: 0, stdout: "shadow: same\n", stderr: "" });
  });

  test("should print one line per difference, exit 3 and log it", async () => {
    const parent = tempFolder();
    const stateFolder = join(parent, "sync-settings");
    try {
      const line = "import dotfiles/x: program ADDED, engine nothing";
      const outcome = await runShadow({
        stateFolder,
        program: () => shadowResult(["  ADDED dotfiles/x"]),
        engine: async () => shadowResult([]),
        now: () => new Date(STAMP),
      });
      expect(outcome).toEqual({
        code: 3,
        stdout: `${line}\n`,
        stderr: "",
      });
      expect(readFileSync(join(stateFolder, "shadow.log"), "utf8")).toBe(
        `${STAMP} ${line}\n`,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("mksync front", () => {
  test("should keep shadow out of the usage line", () => {
    expect(USAGE.includes("shadow")).toBe(false);
  });
});
