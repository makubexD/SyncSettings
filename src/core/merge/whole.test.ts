import { describe, expect, test } from "bun:test";
import type { MergeType } from "../config/types.ts";
import { strategyFor } from "./strategy.ts";
import type { LayerFile, MergeContext, SplitContext } from "./types.ts";
import { WHOLE } from "./whole.ts";

const LF: MergeContext = { eol: "\n" };

const WRITE_PATH = "dotfiles/common/git/.gitconfig.local";

const NO_LAYER = { ok: false, error: "no layer holds the file" } as const;

const BASE: LayerFile = {
  repoPath: "dotfiles/common/git/.gitconfig.local",
  bytes: bytes("base\n"),
};

const OS: LayerFile = {
  repoPath: "dotfiles/linux/git/.gitconfig.local",
  bytes: bytes("linux\n"),
};

const SPLIT: SplitContext = { writeRepoPath: WRITE_PATH };

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("WHOLE merge", () => {
  test("one layer is that layer's bytes", () => {
    // Act
    const result = WHOLE.merge([BASE], LF);

    // Assert
    expect(result).toEqual({ ok: true, value: BASE.bytes });
  });

  test("the last of two layers wins and the first is ignored", () => {
    // Act
    const result = WHOLE.merge([BASE, OS], LF);

    // Assert
    expect(result).toEqual({ ok: true, value: OS.bytes });
  });

  test("no layer is an error", () => {
    // Act
    const result = WHOLE.merge([], LF);

    // Assert
    expect(result).toEqual(NO_LAYER);
  });
});

describe("WHOLE split", () => {
  test("a changed file goes to the last of two layers", () => {
    // Arrange
    const local = bytes("changed\n");

    // Act
    const result = WHOLE.split(local, [BASE, OS], SPLIT);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: [{ repoPath: OS.repoPath, bytes: local }],
    });
  });

  test("a file no layer holds goes to the write root", () => {
    // Arrange
    const local = bytes("new\n");

    // Act
    const result = WHOLE.split(local, [], SPLIT);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: [{ repoPath: WRITE_PATH, bytes: local }],
    });
  });

  test("identical bytes make no change", () => {
    // Act
    const result = WHOLE.split(BASE.bytes, [BASE], SPLIT);

    // Assert
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe("strategyFor", () => {
  test("whole is the whole strategy", () => {
    expect(strategyFor("whole")).toBe(WHOLE);
  });

  test("json, import, dconf and dir have no strategy yet", () => {
    const pending: readonly MergeType[] = ["json", "import", "dconf", "dir"];

    for (const merge of pending) {
      expect(strategyFor(merge)).toBeUndefined();
    }
  });
});
