import { describe, expect, test } from "bun:test";
import { quoteToken } from "./quote.ts";

describe("quoteToken", () => {
  test("leaves a plain token unquoted on every OS", () => {
    for (const os of ["linux", "macos", "windows"] as const) {
      expect(quoteToken("acme-1_a.b@c/d:e+f=g", os)).toBe("acme-1_a.b@c/d:e+f=g");
    }
  });

  test("wraps a token with a space in single quotes", () => {
    expect(quoteToken("Big Co", "linux")).toBe("'Big Co'");
    expect(quoteToken("Big Co", "windows")).toBe("'Big Co'");
  });

  test("writes a quote as '\\'' on linux and macos", () => {
    expect(quoteToken("it's", "linux")).toBe("'it'\\''s'");
    expect(quoteToken("it's", "macos")).toBe("'it'\\''s'");
  });

  test("doubles a quote on windows", () => {
    expect(quoteToken("it's", "windows")).toBe("'it''s'");
  });

  test("doubles a typographic quote on windows, which PowerShell reads as '", () => {
    expect(quoteToken("O\u2019Brien", "windows")).toBe("'O\u2019\u2019Brien'");
  });

  test("leaves a typographic quote alone on linux", () => {
    expect(quoteToken("O\u2019Brien", "linux")).toBe("'O\u2019Brien'");
  });

  test("quotes a token with a shell character", () => {
    expect(quoteToken("a&b", "linux")).toBe("'a&b'");
  });
});
