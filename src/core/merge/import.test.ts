import { describe, expect, test } from "bun:test";
import { IMPORT_MARKER, mergeImport, splitImport } from "./import.ts";
import type { ImportLayer } from "./import.ts";

const LF = "\n";
const CRLF = "\r\n";

const IMPORT_NAME = "CLAUDE.{layer}.md";
const BASE_LABEL = "base";
const LINUX_LABEL = "linux";
const MACOS_LABEL = "macos";
const WORK_PROFILE_LABEL = "work-1";

const BASE_REPO_PATH = "dotfiles/common/claude/CLAUDE.md";
const LINUX_REPO_PATH = "dotfiles/linux/claude/CLAUDE.md";
const MACOS_REPO_PATH = "dotfiles/macos/claude/CLAUDE.md";
const PROFILE_REPO_PATH = "profiles/work-1/claude/CLAUDE.md";

const BASE_TEXT = "# Base\n@RTK.md\n";
const EDITED_BASE_TEXT = "# Base2\n@RTK.md\n";
const LINUX_TEXT = "# Linux\n";
const LINUX_CRLF_TEXT = "# Linux\r\n";
const PROFILE_TEXT = "# Work\n";
const BASE_NO_NEWLINE_TEXT = "# Base";

const BLOCK_LOCAL_TEXT = `${BASE_TEXT}${IMPORT_MARKER}\n@CLAUDE.linux.md\n`;
const EDITED_BLOCK_LINE_TEXT = `${BASE_TEXT}${IMPORT_MARKER}\n@CLAUDE.other.md\n`;
const DELETED_BLOCK_LINE_TEXT = `${BASE_TEXT}${IMPORT_MARKER}\n`;
const EDITED_BASE_AND_BLOCK_TEXT = `${EDITED_BASE_TEXT}${IMPORT_MARKER}\n@CLAUDE.other.md\n`;
const CRLF_EDITED_BASE_TEXT = `${EDITED_BASE_TEXT.replaceAll("\n", "\r\n")}${IMPORT_MARKER}\r\n@CLAUDE.linux.md\r\n`;
const QUOTED_MARKER_BASE_TEXT = `# Base\n${IMPORT_MARKER}\n# still base\n`;
const QUOTED_MARKER_LOCAL_TEXT = `${QUOTED_MARKER_BASE_TEXT}${IMPORT_MARKER}\n@CLAUDE.linux.md\n`;
const MARKER_BEFORE_BASE_TEXT = `${BASE_TEXT}${IMPORT_MARKER}\n# trailing base\n`;

const NO_LAYER = { ok: false, error: "no layer holds the file" } as const;

const BASE_LAYER: ImportLayer = {
  label: BASE_LABEL,
  repoPath: BASE_REPO_PATH,
  bytes: bytes(BASE_TEXT),
};

const LINUX_LAYER: ImportLayer = {
  label: LINUX_LABEL,
  repoPath: LINUX_REPO_PATH,
  bytes: bytes(LINUX_TEXT),
};

const LINUX_CRLF_LAYER: ImportLayer = {
  label: LINUX_LABEL,
  repoPath: LINUX_REPO_PATH,
  bytes: bytes(LINUX_CRLF_TEXT),
};

const PROFILE_LAYER: ImportLayer = {
  label: WORK_PROFILE_LABEL,
  repoPath: PROFILE_REPO_PATH,
  bytes: bytes(PROFILE_TEXT),
};

const ABSENT_BASE_LAYER: ImportLayer = {
  label: BASE_LABEL,
  repoPath: BASE_REPO_PATH,
  bytes: undefined,
};

const ABSENT_MACOS_LAYER: ImportLayer = {
  label: MACOS_LABEL,
  repoPath: MACOS_REPO_PATH,
  bytes: undefined,
};

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function mergeOk(
  layers: readonly ImportLayer[],
  eol: "\n" | "\r\n" = LF,
): { readonly local: Uint8Array; readonly sideFiles: readonly { readonly name: string; readonly repoPath: string; readonly bytes: Uint8Array }[] } {
  const result = mergeImport(layers, IMPORT_NAME, eol);
  if (!result.ok) {
    throw new Error(`expected a merge, got ${result.error}`);
  }
  return result.value;
}

describe("mergeImport", () => {
  test("a base only writes the base text and no marker", () => {
    // Act
    const merged = mergeOk([BASE_LAYER]);

    // Assert
    expect(text(merged.local)).toBe(BASE_TEXT);
    expect(merged.sideFiles).toEqual([]);
  });

  test("one later layer writes the marker, its @ line and its side file", () => {
    // Act
    const merged = mergeOk([BASE_LAYER, LINUX_LAYER]);

    // Assert
    expect(text(merged.local)).toBe(BLOCK_LOCAL_TEXT);
    expect(merged.sideFiles).toEqual([
      {
        name: "CLAUDE.linux.md",
        repoPath: LINUX_REPO_PATH,
        bytes: bytes(LINUX_TEXT),
      },
    ]);
  });

  test("two later layers give two @ lines and side files in layer order", () => {
    // Act
    const merged = mergeOk([BASE_LAYER, LINUX_LAYER, PROFILE_LAYER]);

    // Assert
    expect(text(merged.local)).toBe(
      `${BASE_TEXT}${IMPORT_MARKER}\n@CLAUDE.linux.md\n@CLAUDE.work-1.md\n`,
    );
    expect(merged.sideFiles.map((file) => file.name)).toEqual([
      "CLAUDE.linux.md",
      "CLAUDE.work-1.md",
    ]);
  });

  test("a layer with no file gets no @ line and no side file", () => {
    // Act
    const merged = mergeOk([BASE_LAYER, ABSENT_MACOS_LAYER, LINUX_LAYER]);

    // Assert
    expect(text(merged.local)).toBe(BLOCK_LOCAL_TEXT);
    expect(merged.sideFiles.map((file) => file.name)).toEqual([
      "CLAUDE.linux.md",
    ]);
  });

  test("a base without a final newline gets one before the block", () => {
    // Arrange
    const baseNoNewline: ImportLayer = {
      label: BASE_LABEL,
      repoPath: BASE_REPO_PATH,
      bytes: bytes(BASE_NO_NEWLINE_TEXT),
    };

    // Act
    const merged = mergeOk([baseNoNewline, LINUX_LAYER]);

    // Assert
    expect(text(merged.local)).toBe(
      `${BASE_NO_NEWLINE_TEXT}\n${IMPORT_MARKER}\n@CLAUDE.linux.md\n`,
    );
  });

  test("a base slot with no file is an error", () => {
    // Act
    const result = mergeImport([ABSENT_BASE_LAYER, LINUX_LAYER], IMPORT_NAME, LF);

    // Assert
    expect(result).toEqual(NO_LAYER);
  });

  test("no layers at all is an error", () => {
    // Act
    const result = mergeImport([], IMPORT_NAME, LF);

    // Assert
    expect(result).toEqual(NO_LAYER);
  });

  test("eol CRLF writes CRLF in the local file and the side file", () => {
    // Act
    const merged = mergeOk([BASE_LAYER, LINUX_CRLF_LAYER], CRLF);

    // Assert
    expect(text(merged.local)).toBe(
      `${BASE_TEXT.replaceAll("\n", "\r\n")}${IMPORT_MARKER}\r\n@CLAUDE.linux.md\r\n`,
    );
    expect(text(merged.sideFiles[0]?.bytes ?? bytes(""))).toBe(
      "# Linux\r\n",
    );
  });

  test("eol LF folds a side file's CRLF to LF", () => {
    // Act
    const merged = mergeOk([BASE_LAYER, LINUX_CRLF_LAYER], LF);

    // Assert
    expect(text(merged.sideFiles[0]?.bytes ?? bytes(""))).toBe(LINUX_TEXT);
  });

  test("every {layer} in the import name is replaced", () => {
    // Arrange
    const repeatedName = "CLAUDE.{layer}.{layer}.md";

    // Act
    const result = mergeImport([BASE_LAYER, LINUX_LAYER], repeatedName, LF);

    // Assert
    expect(result.ok && result.value.sideFiles[0]?.name).toBe(
      "CLAUDE.linux.linux.md",
    );
  });
});

describe("splitImport", () => {
  test("case 7: an edit above the marker goes to the base text", () => {
    // Arrange
    const local = bytes(`${EDITED_BASE_TEXT}${IMPORT_MARKER}\n@CLAUDE.linux.md\n`);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toEqual(bytes(EDITED_BASE_TEXT));
    expect(split.blockEdited).toBe(false);
  });

  test("case 8: a changed block line is edited and nothing goes to the base", () => {
    // Arrange
    const local = bytes(EDITED_BLOCK_LINE_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toBeUndefined();
    expect(split.blockEdited).toBe(true);
  });

  test("case 8: a deleted block line is edited", () => {
    // Arrange
    const local = bytes(DELETED_BLOCK_LINE_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.blockEdited).toBe(true);
  });

  test("a marker missing while a later layer holds the file is edited", () => {
    // Arrange
    const local = bytes(BASE_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toBeUndefined();
    expect(split.blockEdited).toBe(true);
  });

  test("a marker present while no later layer holds the file is edited", () => {
    // Arrange
    const local = bytes(BLOCK_LOCAL_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toBeUndefined();
    expect(split.blockEdited).toBe(true);
  });

  test("case 9: CRLF alone is no change", () => {
    // Arrange
    const local = bytes(
      `${BASE_TEXT.replaceAll("\n", "\r\n")}${IMPORT_MARKER}\r\n@CLAUDE.linux.md\r\n`,
    );

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toBeUndefined();
    expect(split.blockEdited).toBe(false);
  });

  test("a base-only pull splits back to no change", () => {
    // Arrange
    const local = bytes(BASE_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toBeUndefined();
    expect(split.blockEdited).toBe(false);
  });

  test("@RTK.md above the marker stays base text", () => {
    // Arrange
    const local = bytes(BLOCK_LOCAL_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toBeUndefined();
    expect(split.blockEdited).toBe(false);
  });

  test("a marker quoted in the base text stays base text", () => {
    // Arrange
    const local = bytes(QUOTED_MARKER_LOCAL_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toEqual(bytes(QUOTED_MARKER_BASE_TEXT));
    expect(split.blockEdited).toBe(false);
  });

  test("a marker followed by a non-@ line stays base text", () => {
    // Arrange
    const local = bytes(MARKER_BEFORE_BASE_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toEqual(bytes(MARKER_BEFORE_BASE_TEXT));
    expect(split.blockEdited).toBe(false);
  });

  test("case 7 and an edited block at once gives both", () => {
    // Arrange
    const local = bytes(EDITED_BASE_AND_BLOCK_TEXT);

    // Act
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);

    // Assert
    expect(split.base).toEqual(bytes(EDITED_BASE_TEXT));
    expect(split.blockEdited).toBe(true);
  });

  test("pull after push is byte-exact for a CRLF local file", () => {
    // Arrange
    const local = bytes(CRLF_EDITED_BASE_TEXT);
    const split = splitImport(local, [BASE_LAYER, LINUX_LAYER], IMPORT_NAME);
    const applied: readonly ImportLayer[] = [
      { ...BASE_LAYER, bytes: split.base ?? BASE_LAYER.bytes },
      LINUX_LAYER,
    ];

    // Act
    const merged = mergeOk(applied, CRLF);

    // Assert
    expect(text(merged.local)).toBe(CRLF_EDITED_BASE_TEXT);
  });

  test("push right after pull of a base without a final newline is no change", () => {
    // Arrange
    const baseNoNewline: ImportLayer = {
      label: BASE_LABEL,
      repoPath: BASE_REPO_PATH,
      bytes: bytes(BASE_NO_NEWLINE_TEXT),
    };
    const pulled = mergeOk([baseNoNewline, LINUX_LAYER]);

    // Act
    const split = splitImport(
      pulled.local,
      [baseNoNewline, LINUX_LAYER],
      IMPORT_NAME,
    );

    // Assert
    expect(split).toEqual({ base: undefined, blockEdited: false });
  });
});
