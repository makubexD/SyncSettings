import { describe, expect, test } from "bun:test";
import { ownedPaths } from "../core/plan/diff.ts";
import type { RepoFiles } from "../core/plan/types.ts";
import { conflictLines } from "./diff.ts";

const A = "dotfiles/common/parity/a.conf";
const B = "dotfiles/common/parity/b.conf";
const JSON_BASE = "dotfiles/common/parity/s.json";
const JSON_OS = "dotfiles/linux/parity/s.json";
const JSON_MACHINE = "machines/box1/parity/s.json";
const JSON_PRIVATE = "dotfiles/private/parity/s.json";

const OWNED = ownedPaths([
  { repoPath: A },
  { repoPath: B },
  {
    repoPath: JSON_OS,
    layerPaths: [JSON_BASE, JSON_OS, JSON_MACHINE, JSON_PRIVATE],
  },
]);

function tree(files: Readonly<Record<string, string>>): RepoFiles {
  const encoder = new TextEncoder();
  return new Map(
    Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]),
  );
}

describe("conflictLines", () => {
  test("should give a block to a BOTH label only", async () => {
    const lines = await conflictLines({
      labels: [
        { label: "OUT", path: A },
        { label: "BOTH", path: B },
      ],
      owned: OWNED,
      theirs: tree({ [A]: "x\n", [B]: "repo line\n" }),
      mine: tree({ [A]: "y\n", [B]: "machine line\n" }),
      privatePaths: new Set(),
    });

    expect(lines).toEqual([
      `  --- repo           ${B}`,
      `  +++ this machine   ${B}`,
      "  @@ -1 +1 @@",
      "  -repo line",
      "  +machine line",
    ]);
  });

  test("should mark the side that lacks the file", async () => {
    const lines = await conflictLines({
      labels: [{ label: "BOTH", path: B }],
      owned: OWNED,
      theirs: tree({}),
      mine: tree({ [B]: "new\n" }),
      privatePaths: new Set(),
    });

    expect(lines[0]).toBe(`  --- repo           ${B} (missing)`);
    expect(lines.at(-1)).toBe("  +new");
  });

  test("should give a json label one block per differing public layer", async () => {
    const lines = await conflictLines({
      labels: [{ label: "BOTH", path: JSON_OS }],
      owned: OWNED,
      theirs: tree({
        [JSON_BASE]: "1\n",
        [JSON_OS]: "1\n",
        [JSON_MACHINE]: "1\n",
        [JSON_PRIVATE]: "1\n",
      }),
      mine: tree({
        [JSON_BASE]: "2\n",
        [JSON_OS]: "2\n",
        [JSON_MACHINE]: "2\n",
        [JSON_PRIVATE]: "2\n",
      }),
      privatePaths: new Set([JSON_MACHINE, JSON_PRIVATE]),
    });

    expect(lines.filter((line) => line.startsWith("  --- "))).toEqual([
      `  --- repo           ${JSON_BASE}`,
      `  --- repo           ${JSON_OS}`,
    ]);
  });

  test("should leave out a layer both sides hold alike", async () => {
    const lines = await conflictLines({
      labels: [{ label: "BOTH", path: JSON_OS }],
      owned: OWNED,
      theirs: tree({ [JSON_BASE]: "1\n", [JSON_OS]: "1\n" }),
      mine: tree({ [JSON_BASE]: "1\n", [JSON_OS]: "2\n" }),
      privatePaths: new Set(),
    });

    expect(lines.filter((line) => line.startsWith("  --- "))).toEqual([
      `  --- repo           ${JSON_OS}`,
    ]);
  });
});
