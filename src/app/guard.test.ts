import { describe, expect, test } from "bun:test";
import type { Result } from "./export.ts";
import { blockedLines, blockedPaths, diffCounts } from "./guard.ts";

const OUT_LINE = "  OUT        dotfiles/common/parity/a.conf";

const BOTH_LINE = "  BOTH       dotfiles/common/parity/b.conf";

const IN_LINE = "  IN         dotfiles/common/parity/c.conf";

const UNKNOWN_LINE = "  ?          dotfiles/common/parity/d.conf";

function diff(lines: readonly string[]): Result {
  return { code: 3, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

describe("blockedLines", () => {
  test("should keep OUT and BOTH lines and drop IN and ?", () => {
    // Act
    const blocked = blockedLines(
      diff([OUT_LINE, IN_LINE, BOTH_LINE, UNKNOWN_LINE]),
    );

    // Assert
    expect(blocked).toEqual([OUT_LINE, BOTH_LINE]);
  });

  test("should count the blocking lines by their length", () => {
    // Act
    const blocked = blockedLines(diff([OUT_LINE, BOTH_LINE]));

    // Assert
    expect(blocked.length).toBe(2);
  });

  test("should keep no lines when the diff has only IN and ?", () => {
    // Act
    const blocked = blockedLines(diff([IN_LINE, UNKNOWN_LINE]));

    // Assert
    expect(blocked).toEqual([]);
  });
});

describe("blockedPaths", () => {
  test("should give the paths of the OUT and BOTH lines in order", () => {
    // Arrange
    const lines = [OUT_LINE, BOTH_LINE];

    // Act
    const paths = blockedPaths(lines);

    // Assert
    expect(paths).toEqual([
      "dotfiles/common/parity/a.conf",
      "dotfiles/common/parity/b.conf",
    ]);
  });

  test("should give no path for IN and ? lines and for summary or hint lines", () => {
    // Arrange
    const summary = "  2 file(s) differ: 1 in, 0 out, 0 both.";
    const hint = "  IN: mksync pull takes them.";

    // Act
    const paths = blockedPaths([IN_LINE, UNKNOWN_LINE, summary, hint]);

    // Assert
    expect(paths).toEqual([]);
  });

  test("should keep a path with a space whole", () => {
    // Arrange
    const line = "  OUT        dotfiles/common/my folder/a b.conf";

    // Act
    const paths = blockedPaths([line]);

    // Assert
    expect(paths).toEqual(["dotfiles/common/my folder/a b.conf"]);
  });
});

describe("diffCounts", () => {
  test("should count the IN, OUT and BOTH lines", () => {
    // Act
    const counts = diffCounts(
      diff([OUT_LINE, IN_LINE, BOTH_LINE, IN_LINE, UNKNOWN_LINE]),
    );

    // Assert
    expect(counts).toEqual({ inCount: 2, outCount: 1, bothCount: 1 });
  });

  test("should return zeroes when the diff printed no label lines", () => {
    // Act
    const counts = diffCounts({ code: 0, stdout: "", stderr: "" });

    // Assert
    expect(counts).toEqual({ inCount: 0, outCount: 0, bothCount: 0 });
  });
});
