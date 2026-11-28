import { describe, expect, test } from "bun:test";
import { DEFAULT_NO, trimAnswer, yesNoAnswer } from "./answer.ts";

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

describe("yesNoAnswer", () => {
  const YES_ON_EMPTY = { empty: true, end: false };

  test("should take an answer starting with y or Y as yes", () => {
    // Act / Assert
    expect(yesNoAnswer("y", DEFAULT_NO)).toBe(true);
    expect(yesNoAnswer(" Yes\r", DEFAULT_NO)).toBe(true);
  });

  test("should take any other answer as no, whatever the defaults", () => {
    // Act / Assert
    expect(yesNoAnswer("n", YES_ON_EMPTY)).toBe(false);
    expect(yesNoAnswer("x", YES_ON_EMPTY)).toBe(false);
  });

  test("should give an empty answer the empty default", () => {
    // Act / Assert
    expect(yesNoAnswer(" \t", YES_ON_EMPTY)).toBe(true);
    expect(yesNoAnswer("", DEFAULT_NO)).toBe(false);
  });

  test("should give end of input the end default, not the empty one", () => {
    // Act / Assert
    expect(yesNoAnswer(undefined, YES_ON_EMPTY)).toBe(false);
    expect(yesNoAnswer(undefined, { empty: false, end: true })).toBe(true);
  });
});
