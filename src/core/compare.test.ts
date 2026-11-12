import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { foldCrlf, same } from "./compare.ts";
import { formatLine, STATUS_WORDS } from "./status.ts";
import type { StatusWord } from "./status.ts";
import { sanitize } from "./values/sanitize.ts";

const CASE_ROOT = new URL("../../tests/parity/cases/", import.meta.url);

const PARITY_RULES = [{ placeholder: "<YOUR_NAME>", prompt: "Full name" }];
const PARITY_VALUES = { "<YOUR_NAME>": "Parity User" };

interface LineCase {
  readonly word: StatusWord;
  readonly plain: string;
  readonly noted: string;
}

const LINE_CASES: readonly LineCase[] = [
  {
    word: "SKIPPED",
    plain: "  SKIPPED    parity",
    noted: "  SKIPPED    parity  (note)",
  },
  { word: "ADDED", plain: "  ADDED      parity", noted: "  ADDED      parity  (note)" },
  {
    word: "UNCHANGED",
    plain: "  UNCHANGED  parity",
    noted: "  UNCHANGED  parity  (note)",
  },
  {
    word: "MODIFIED",
    plain: "  MODIFIED   parity",
    noted: "  MODIFIED   parity  (note)",
  },
  {
    word: "REMOVED",
    plain: "  REMOVED    parity",
    noted: "  REMOVED    parity  (note)",
  },
  { word: "ERROR", plain: "  ERROR      parity", noted: "  ERROR      parity  (note)" },
  {
    word: "CREATED",
    plain: "  CREATED    parity",
    noted: "  CREATED    parity  (note)",
  },
  {
    word: "UPDATED",
    plain: "  UPDATED    parity",
    noted: "  UPDATED    parity  (note)",
  },
  { word: "EXTRA", plain: "  EXTRA      parity", noted: "  EXTRA      parity  (note)" },
  {
    word: "ORPHAN",
    plain: "  ORPHAN     parity",
    noted: "  ORPHAN     parity  (note)",
  },
  { word: "DRIFT", plain: "  DRIFT      parity", noted: "  DRIFT      parity  (note)" },
];

function caseBytes(name: string, relativePath: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`${name}/${relativePath}`, CASE_ROOT)),
  );
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("same", () => {
  test("should call a shared CRLF file different on Linux", () => {
    // Arrange
    const repo = caseBytes("common-crlf", "repo/dotfiles/common/parity/a.conf");
    const local = caseBytes("common-crlf", "home/.config/parity/a.conf");

    // Act
    const result = same(repo, local, {
      os: "linux",
      shared: true,
      sanitized: false,
    });

    // Assert
    expect(result).toBe(false);
  });

  test("should call a shared CRLF file the same on Windows", () => {
    // Arrange
    const repo = caseBytes("common-crlf", "repo/dotfiles/common/parity/a.conf");
    const local = caseBytes("common-crlf", "home/.config/parity/a.conf");

    // Act
    const result = same(repo, local, {
      os: "windows",
      shared: true,
      sanitized: false,
    });

    // Assert
    expect(result).toBe(true);
  });

  test("should not fold CRLF for a file under dotfiles/windows on Windows", () => {
    // Arrange
    const repo = encode("status = local\n");
    const local = encode("status = local\r\n");

    // Act
    const result = same(repo, local, {
      os: "windows",
      shared: false,
      sanitized: false,
    });

    // Assert
    expect(result).toBe(false);
  });

  test("should call sanitized text the same when only CRLF and trailing blank lines differ", () => {
    // Arrange
    const repo = caseBytes(
      "sanitized-crlf-unchanged",
      "repo/dotfiles/common/parity/a.conf",
    );
    const local = sanitize(
      caseBytes("sanitized-crlf-unchanged", "home/.config/parity/a.conf"),
      PARITY_RULES,
      PARITY_VALUES,
      { json: false },
    );

    // Act
    const result = same(repo, local, {
      os: "linux",
      shared: true,
      sanitized: true,
    });

    // Assert
    expect(result).toBe(true);
  });

  test("should keep a file holding a NUL byte byte for byte on Windows", () => {
    // Arrange
    const repo = new Uint8Array([...encode("status = local\n"), 0x00]);
    const local = new Uint8Array([...encode("status = local\r\n"), 0x00]);

    // Act
    const result = same(repo, local, {
      os: "windows",
      shared: true,
      sanitized: false,
    });

    // Assert
    expect(result).toBe(false);
  });

  test("should ignore trailing blank lines and spaces when sanitized", () => {
    // Arrange
    const repo = encode("name=<YOUR_NAME>\n");
    const local = encode("name=<YOUR_NAME>\r\n\r\n  \t\n");

    // Act
    const result = same(repo, local, {
      os: "linux",
      shared: true,
      sanitized: true,
    });

    // Assert
    expect(result).toBe(true);
  });

  test("should keep trailing blank lines and spaces when not sanitized", () => {
    // Arrange
    const repo = encode("name=<YOUR_NAME>\n");
    const local = encode("name=<YOUR_NAME>\r\n\r\n  \t\n");

    // Act
    const result = same(repo, local, {
      os: "linux",
      shared: true,
      sanitized: false,
    });

    // Assert
    expect(result).toBe(false);
  });

  test("should compare case-sensitively", () => {
    // Arrange
    const repo = encode("Name = Parity User\n");
    const local = encode("name = Parity User\n");

    // Act
    const result = same(repo, local, {
      os: "linux",
      shared: false,
      sanitized: true,
    });

    // Assert
    expect(result).toBe(false);
  });
});

describe("foldCrlf", () => {
  test("should turn CRLF into LF and leave a lone carriage return", () => {
    // Arrange
    const input = new Uint8Array([0x61, 0x0d, 0x62, 0x0d, 0x0a, 0x63]);
    const expected = new Uint8Array([0x61, 0x0d, 0x62, 0x0a, 0x63]);

    // Act
    const result = foldCrlf(input);

    // Assert
    expect(result).toEqual(expected);
  });
});

describe("formatLine", () => {
  for (const lineCase of LINE_CASES) {
    test(`should format ${lineCase.word} without a note`, () => {
      // Arrange
      const label = "parity";

      // Act
      const result = formatLine(lineCase.word, label);

      // Assert
      expect(result).toBe(lineCase.plain);
    });

    test(`should format ${lineCase.word} with a note`, () => {
      // Arrange
      const label = "parity";
      const note = "note";

      // Act
      const result = formatLine(lineCase.word, label, note);

      // Assert
      expect(result).toBe(lineCase.noted);
    });
  }

  test("should print no parentheses for an empty note", () => {
    // Arrange
    const label = "parity";

    // Act
    const result = formatLine("UNCHANGED", label, "");

    // Assert
    expect(result).toBe("  UNCHANGED  parity");
  });

  test("should cover every status word", () => {
    // Arrange
    const formattedWords = LINE_CASES.map((lineCase) => lineCase.word);

    // Act
    const result = formattedWords;

    // Assert
    expect(result).toEqual([...STATUS_WORDS]);
  });
});
