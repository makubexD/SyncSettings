import { describe, expect, test } from "bun:test";
import { trimAnswer } from "./answer.ts";

/** A non-breaking space: Unicode whitespace `String.prototype.trim` drops. */
const NBSP = String.fromCharCode(0x00a0);

describe("trimAnswer", () => {
  test("should drop spaces, tabs and carriage returns at both ends", () => {
    // Arrange
    const raw = " a b \t\r";

    // Act
    const actual = trimAnswer(raw);

    // Assert
    expect(actual).toBe("a b");
  });

  test("should return an empty string for only spaces", () => {
    // Arrange
    const raw = "   ";

    // Act
    const actual = trimAnswer(raw);

    // Assert
    expect(actual).toBe("");
  });

  test("should return an empty string for a carriage return alone", () => {
    // Arrange
    const raw = "\r";

    // Act
    const actual = trimAnswer(raw);

    // Assert
    expect(actual).toBe("");
  });

  test("should keep non-breaking spaces at both ends", () => {
    // Arrange
    const raw = `${NBSP}x${NBSP}`;

    // Act
    const actual = trimAnswer(raw);

    // Assert
    expect(actual).toBe(`${NBSP}x${NBSP}`);
  });
});
