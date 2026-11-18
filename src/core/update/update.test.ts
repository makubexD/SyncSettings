import { describe, expect, test } from "bun:test";
import { assetName, isNewer, parseSums, planUpdate } from "./update.ts";

const LINUX_X64_SHA = "0123456789abcdef".repeat(4);
const LINUX_ARM_SHA = "FEDCBA9876543210".repeat(4);
const WRONG_SHA = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("assetName", () => {
  test("should name the Linux x64 program", () => {
    // Act / Assert
    expect(assetName("linux", "x64")).toBe("mksync-linux-x64");
  });

  test("should name the Linux arm64 program", () => {
    // Act / Assert
    expect(assetName("linux", "arm64")).toBe("mksync-linux-arm64");
  });

  test("should name the macOS arm64 program", () => {
    // Act / Assert
    expect(assetName("darwin", "arm64")).toBe("mksync-darwin-arm64");
  });

  test("should name the Windows x64 program", () => {
    // Act / Assert
    expect(assetName("win32", "x64")).toBe("mksync-windows-x64.exe");
  });

  test("should have no program for an unsupported pair", () => {
    // Act / Assert
    expect(assetName("linux", "ia32")).toBeUndefined();
  });
});

describe("parseSums", () => {
  test("should map each name to its lowercase digest", () => {
    // Arrange
    const text = `${LINUX_X64_SHA}  mksync-linux-x64\r\n${LINUX_ARM_SHA} *mksync-linux-arm64\r\n`;

    // Act
    const parsed = parseSums(text);

    // Assert
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected SHA256SUMS to parse");
    }
    expect([...parsed.value]).toEqual([
      ["mksync-linux-x64", LINUX_X64_SHA],
      ["mksync-linux-arm64", LINUX_ARM_SHA.toLowerCase()],
    ]);
  });

  test("should refuse a malformed line naming its number", () => {
    // Arrange
    const text = `${LINUX_X64_SHA}  mksync-linux-x64\nnot a checksum line\n`;

    // Act
    const parsed = parseSums(text);

    // Assert
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("expected SHA256SUMS to refuse");
    }
    expect(parsed.error).toBe(
      "SHA256SUMS line 2: expected <64 hex>  <name>",
    );
  });
});

describe("isNewer", () => {
  test("should be newer across a numeric field", () => {
    // Act / Assert
    expect(isNewer("0.9.0", "v0.10.0")).toBe(true);
  });

  test("should not be newer for the same version", () => {
    // Act / Assert
    expect(isNewer("1.0.0", "v1.0.0")).toBe(false);
  });

  test("should not be newer for an older version", () => {
    // Act / Assert
    expect(isNewer("1.2.0", "v1.1.9")).toBe(false);
  });
});

describe("planUpdate", () => {
  test("should stay up to date when the tag is not newer", () => {
    // Arrange
    const input = {
      current: "1.0.0",
      latestTag: "v1.0.0",
      expectedSha: LINUX_X64_SHA,
    };

    // Act
    const plan = planUpdate(input);

    // Assert
    expect(plan).toEqual({ kind: "up-to-date" });
  });

  test("should replace when the digest matches", () => {
    // Arrange
    const input = {
      current: "0.9.0",
      latestTag: "v0.10.0",
      expectedSha: LINUX_ARM_SHA,
      downloadedSha: LINUX_ARM_SHA.toLowerCase(),
    };

    // Act
    const plan = planUpdate(input);

    // Assert
    expect(plan).toEqual({
      kind: "replace",
      from: "0.9.0",
      to: "0.10.0",
    });
  });

  test("should refuse when the digest does not match", () => {
    // Arrange
    const input = {
      current: "0.9.0",
      latestTag: "v0.10.0",
      expectedSha: LINUX_ARM_SHA.toLowerCase(),
      downloadedSha: WRONG_SHA,
    };

    // Act
    const plan = planUpdate(input);

    // Assert
    expect(plan).toEqual({
      kind: "mismatch",
      expected: LINUX_ARM_SHA.toLowerCase(),
      actual: WRONG_SHA,
    });
  });
});
