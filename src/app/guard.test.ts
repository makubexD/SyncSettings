import { describe, expect, test } from "bun:test";
import type { Result } from "./export.ts";
import { blockedLines, diffCounts } from "./guard.ts";

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
