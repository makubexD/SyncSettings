import { describe, expect, test } from "bun:test";
import { compareShadow, renderShadow } from "./shadow.ts";
import type { ShadowResult } from "./shadow.ts";

const STAMP = "2026-11-12T10:00:00.000Z";

interface Codes {
  readonly checkCode?: number;
  readonly previewCode?: number;
  readonly exportCode?: number;
}

function shadowResult(
  checkLines: readonly string[],
  exported: Readonly<Record<string, string>> = {},
  previewLines: readonly string[] = [],
  codes: Codes = {},
): ShadowResult {
  return {
    checkLines,
    previewLines,
    exported: new Map(Object.entries(exported)),
    checkCode: codes.checkCode ?? 0,
    previewCode: codes.previewCode ?? 0,
    exportCode: codes.exportCode ?? 0,
  };
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

  test("should report a differing check exit code as one line", () => {
    // Arrange
    const program = shadowResult([], {}, [], { checkCode: 0 });
    const engine = shadowResult([], {}, [], { checkCode: 1 });

    // Act
    const differences = compareShadow(program, engine);

    // Assert
    expect(differences).toEqual(["import: program exit 0, engine exit 1"]);
  });

  test("should report a differing export exit code once", () => {
    // Arrange
    const path = "dotfiles/linux/git/.gitconfig";
    const program = shadowResult([], { [path]: "name = <YOUR_NAME>\n" });
    const engine = shadowResult([], {}, [], { exportCode: 1 });

    // Act
    const differences = compareShadow(program, engine);

    // Assert
    expect(differences).toEqual(["export run: program exit 0, engine exit 1"]);
  });
});

describe("renderShadow", () => {
  test("should print shadow: same with no log text when both sides match", () => {
    // Act
    const rendered = renderShadow([], STAMP);

    // Assert
    expect(rendered).toEqual({ code: 0, stdout: "shadow: same\n", logText: "" });
  });

  test("should print one line per difference and stamp each log line", () => {
    // Arrange
    const differences = [
      "import a: program ADDED, engine nothing",
      "export b: only in engine",
    ];

    // Act
    const rendered = renderShadow(differences, STAMP);

    // Assert
    expect(rendered).toEqual({
      code: 3,
      stdout: `${differences.join("\n")}\n`,
      logText: differences.map((line) => `${STAMP} ${line}\n`).join(""),
    });
  });
});
