import { describe, expect, test } from "bun:test";
import type { ConflictSides } from "./conflict.ts";
import { conflictBlock } from "./conflict.ts";

const PATH = "dotfiles/common/parity/b.conf";

const BOTH_PRESENT: ConflictSides = { theirs: true, mine: true };

const REPO_MISSING: ConflictSides = { theirs: false, mine: true };

const MINE_MISSING: ConflictSides = { theirs: true, mine: false };

const REPO_HEADER = `  --- repo           ${PATH}`;

const MINE_HEADER = `  +++ this machine   ${PATH}`;

const REPO_HEADER_MISSING = `${REPO_HEADER} (missing)`;

const MINE_HEADER_MISSING = `${MINE_HEADER} (missing)`;

const HUNK = "@@ -1 +1 @@";

const GIT_HEADER: readonly string[] = [
  `diff --git a/${PATH} b/${PATH}`,
  "index 1a2b3c4..5d6e7f8 100644",
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
];

const HEADER_COUNT = 2;

const BODY_LIMIT = 40;

/** A git header followed by `body`, with a trailing newline like git's stdout. */
function rawDiff(body: readonly string[], eol = "\n"): string {
  return [...GIT_HEADER, ...body].join(eol) + eol;
}

/** A body of `count` lines in total: the hunk line plus removed lines. */
function bodyOf(count: number): readonly string[] {
  const removed = Array.from(
    { length: count - 1 },
    (_, index) => `-line ${index + 1}`,
  );
  return [HUNK, ...removed];
}

function binaryDiff(): string {
  return [
    `diff --git a/${PATH} b/${PATH}`,
    "index 1a2b3c4..5d6e7f8 100644",
    `Binary files a/${PATH} and b/${PATH} differ`,
  ].join("\n") + "\n";
}

const SHORT_DIFF = rawDiff([HUNK, "-repo line", "+machine line"]);

const SHORT_EXPECTED: readonly string[] = [
  REPO_HEADER,
  MINE_HEADER,
  `  ${HUNK}`,
  "  -repo line",
  "  +machine line",
];

describe("conflictBlock", () => {
  test("should show the contract example for a short diff", () => {
    // Arrange
    const diff = SHORT_DIFF;

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines).toEqual(SHORT_EXPECTED);
  });

  test("should show no more line when the body is exactly 40 lines", () => {
    // Arrange
    const diff = rawDiff(bodyOf(BODY_LIMIT));

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines).toHaveLength(HEADER_COUNT + BODY_LIMIT);
    expect(lines.some((line) => line.includes("more line(s)"))).toBe(false);
  });

  test("should report one line left out when the body is 41 lines", () => {
    // Arrange
    const diff = rawDiff(bodyOf(BODY_LIMIT + 1));

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines.at(-1)).toBe("  … 1 more line(s)");
  });

  test("should report 60 lines left out when the body is 100 lines", () => {
    // Arrange
    const diff = rawDiff(bodyOf(100));

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines.at(-1)).toBe("  … 60 more line(s)");
  });

  test("should say binary files differ for a binary diff", () => {
    // Arrange
    const diff = binaryDiff();

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines).toEqual([
      REPO_HEADER,
      MINE_HEADER,
      "  binary files differ",
    ]);
  });

  test("should mark the repo side missing when the repo has no file", () => {
    // Arrange
    const diff = rawDiff([HUNK, "+machine line"]);

    // Act
    const lines = conflictBlock(PATH, REPO_MISSING, diff);

    // Assert
    expect(lines.slice(0, HEADER_COUNT)).toEqual([
      REPO_HEADER_MISSING,
      MINE_HEADER,
    ]);
  });

  test("should mark the machine side missing when this machine has no file", () => {
    // Arrange
    const diff = rawDiff([HUNK, "-repo line"]);

    // Act
    const lines = conflictBlock(PATH, MINE_MISSING, diff);

    // Assert
    expect(lines.slice(0, HEADER_COUNT)).toEqual([
      REPO_HEADER,
      MINE_HEADER_MISSING,
    ]);
  });

  test("should strip a carriage return from CRLF lines", () => {
    // Arrange
    const crlfDiff = rawDiff(
      [HUNK, "-repo line", "+machine line"],
      "\r\n",
    );

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, crlfDiff);

    // Assert
    expect(lines).toEqual(SHORT_EXPECTED);
    expect(lines.some((line) => line.includes("\r"))).toBe(false);
  });

  test("should keep body lines that look like a diff header after a hunk", () => {
    // Arrange
    const diff = rawDiff([HUNK, "--- x", "+++ y"]);

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines.slice(HEADER_COUNT, HEADER_COUNT + 3)).toEqual([
      `  ${HUNK}`,
      "  --- x",
      "  +++ y",
    ]);
  });

  test("should keep the no-newline marker as a body line", () => {
    // Arrange
    const marker = "\\ No newline at end of file";
    const diff = rawDiff([HUNK, "-repo line", marker]);

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines.at(-1)).toBe(`  ${marker}`);
  });

  test("should give only the two header lines for an empty diff", () => {
    // Arrange
    const diff = "";

    // Act
    const lines = conflictBlock(PATH, BOTH_PRESENT, diff);

    // Assert
    expect(lines).toEqual([REPO_HEADER, MINE_HEADER]);
  });
});
