import { describe, expect, test } from "bun:test";
import { diffText, labelDiff, ownedPaths } from "./diff.ts";
import type {
  DiffHeader,
  DiffLabel,
  DiffLine,
  OwnedEntry,
  OwnedPaths,
} from "./diff.ts";
import type { RepoFiles } from "./types.ts";

const BASHRC = "dotfiles/linux/shell/.bashrc";

const GITCONFIG = "dotfiles/common/git/.gitconfig";

const UPPER = "dotfiles/common/Upper.conf";

const LOWER = "dotfiles/common/lower.conf";

const DCONF_FILE = "dotfiles/linux/gnome/dconf/interface.ini";

const FOLDER = "dotfiles/linux/gnome/bookmarks";

const LAYER_BASE = "dotfiles/common/settings.json";

const LAYER_OS = "dotfiles/linux/settings.json";

const V1 = "v1";

const V2 = "v2";

const V3 = "v3";

const SHORT = "1a2b3c4";

const DATE = "2026-11-01";

const REPO_SHORT = "5d6e7f8";

const DASHES = "  --------------------------------------------------";

/** Contract "Picking files": the warning a label-less `--only` run prints. */
const WARNING = "  WARNING: --only matched no file.";

const HEADER: DiffHeader = {
  lastSync: { short: SHORT, date: DATE },
  repo: { ref: "origin/master", short: REPO_SHORT },
};

const NO_SYNC_HEADER: DiffHeader = {
  repo: { ref: "HEAD", short: REPO_SHORT },
};

/** Every path under `dotfiles/` is owned, so a case tests only the table. */
const ALL_OWNED = ownedPaths([{ repoPath: "dotfiles", type: "dir" }]);

/** One layered entry: its base and OS files fold into the OS label. */
const LAYERED: OwnedPaths = ownedPaths([
  { repoPath: LAYER_OS, layerPaths: [LAYER_BASE, LAYER_OS] },
]);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function tree(files: Readonly<Record<string, string>>): RepoFiles {
  const map = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(files)) {
    map.set(path, bytes(text));
  }
  return map;
}

function owns(entry: OwnedEntry, path: string): boolean {
  return ownedPaths([entry]).owns(path);
}

function diffLines(...labels: readonly DiffLabel[]): readonly DiffLine[] {
  return labels.map((label, index) => ({
    label,
    path: `dotfiles/common/case-${index}.conf`,
  }));
}

interface TableCase {
  readonly name: string;
  readonly base: RepoFiles;
  readonly theirs: RepoFiles;
  readonly mine: RepoFiles;
  readonly hasSyncPoint: boolean;
  readonly expected: readonly DiffLine[];
}

const TABLE_CASES: readonly TableCase[] = [
  {
    name: "should leave a path unlabeled when neither side changed",
    base: tree({ [BASHRC]: V1 }),
    theirs: tree({ [BASHRC]: V1 }),
    mine: tree({ [BASHRC]: V1 }),
    hasSyncPoint: true,
    expected: [],
  },
  {
    name: "should label IN when only the repo changed",
    base: tree({ [BASHRC]: V1 }),
    theirs: tree({ [BASHRC]: V2 }),
    mine: tree({ [BASHRC]: V1 }),
    hasSyncPoint: true,
    expected: [{ label: "IN", path: BASHRC }],
  },
  {
    name: "should label OUT when only this machine changed",
    base: tree({ [BASHRC]: V1 }),
    theirs: tree({ [BASHRC]: V1 }),
    mine: tree({ [BASHRC]: V2 }),
    hasSyncPoint: true,
    expected: [{ label: "OUT", path: BASHRC }],
  },
  {
    name: "should leave a path unlabeled when both made the same change",
    base: tree({ [BASHRC]: V1 }),
    theirs: tree({ [BASHRC]: V2 }),
    mine: tree({ [BASHRC]: V2 }),
    hasSyncPoint: true,
    expected: [],
  },
  {
    name: "should label BOTH when both changed differently",
    base: tree({ [BASHRC]: V1 }),
    theirs: tree({ [BASHRC]: V2 }),
    mine: tree({ [BASHRC]: V3 }),
    hasSyncPoint: true,
    expected: [{ label: "BOTH", path: BASHRC }],
  },
  {
    name: "should label ? when there is no sync point and the sides differ",
    base: tree({}),
    theirs: tree({ [BASHRC]: V2 }),
    mine: tree({ [BASHRC]: V3 }),
    hasSyncPoint: false,
    expected: [{ label: "?", path: BASHRC }],
  },
  {
    name: "should leave a path unlabeled without a sync point when the sides agree",
    base: tree({}),
    theirs: tree({ [BASHRC]: V2 }),
    mine: tree({ [BASHRC]: V2 }),
    hasSyncPoint: false,
    expected: [],
  },
];

interface MissingCase {
  readonly name: string;
  readonly base: RepoFiles;
  readonly theirs: RepoFiles;
  readonly mine: RepoFiles;
  readonly hasSyncPoint: boolean;
  readonly expected: readonly DiffLine[];
}

const MISSING_CASES: readonly MissingCase[] = [
  {
    name: "should label OUT a path only this machine has",
    base: tree({}),
    theirs: tree({}),
    mine: tree({ [BASHRC]: V1 }),
    hasSyncPoint: true,
    expected: [{ label: "OUT", path: BASHRC }],
  },
  {
    name: "should label IN a path only the repo has",
    base: tree({}),
    theirs: tree({ [BASHRC]: V1 }),
    mine: tree({}),
    hasSyncPoint: true,
    expected: [{ label: "IN", path: BASHRC }],
  },
  {
    name: "should leave unlabeled a path both sides deleted",
    base: tree({ [BASHRC]: V1 }),
    theirs: tree({}),
    mine: tree({}),
    hasSyncPoint: true,
    expected: [],
  },
  {
    name: "should count a missing path as a version without a sync point",
    base: tree({}),
    theirs: tree({ [BASHRC]: V1 }),
    mine: tree({}),
    hasSyncPoint: false,
    expected: [{ label: "?", path: BASHRC }],
  },
];

const LAYER_CASES: readonly TableCase[] = [
  {
    name: "should label OUT at the entry's label when only the base layer changed",
    base: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    theirs: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    mine: tree({ [LAYER_BASE]: V2, [LAYER_OS]: V1 }),
    hasSyncPoint: true,
    expected: [{ label: "OUT", path: LAYER_OS }],
  },
  {
    name: "should label IN at the entry's label when only the repo's base layer changed",
    base: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    theirs: tree({ [LAYER_BASE]: V2, [LAYER_OS]: V1 }),
    mine: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    hasSyncPoint: true,
    expected: [{ label: "IN", path: LAYER_OS }],
  },
  {
    name: "should fold a base OUT and an OS IN into BOTH",
    base: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    theirs: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V2 }),
    mine: tree({ [LAYER_BASE]: V2, [LAYER_OS]: V1 }),
    hasSyncPoint: true,
    expected: [{ label: "BOTH", path: LAYER_OS }],
  },
  {
    name: "should keep BOTH when one layer is BOTH",
    base: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    theirs: tree({ [LAYER_BASE]: V2, [LAYER_OS]: V1 }),
    mine: tree({ [LAYER_BASE]: V3, [LAYER_OS]: V1 }),
    hasSyncPoint: true,
    expected: [{ label: "BOTH", path: LAYER_OS }],
  },
  {
    name: "should print exactly one OUT when every layer is OUT",
    base: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    theirs: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    mine: tree({ [LAYER_BASE]: V2, [LAYER_OS]: V2 }),
    hasSyncPoint: true,
    expected: [{ label: "OUT", path: LAYER_OS }],
  },
  {
    name: "should print nothing when no layer changed",
    base: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    theirs: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    mine: tree({ [LAYER_BASE]: V1, [LAYER_OS]: V1 }),
    hasSyncPoint: true,
    expected: [],
  },
  {
    name: "should label ? when there is no sync point and a layer differs",
    base: tree({}),
    theirs: tree({ [LAYER_BASE]: V2, [LAYER_OS]: V1 }),
    mine: tree({ [LAYER_BASE]: V3, [LAYER_OS]: V1 }),
    hasSyncPoint: false,
    expected: [{ label: "?", path: LAYER_OS }],
  },
];

describe("ownedPaths", () => {
  test("should own a file entry's path and its linked prefix", () => {
    // Arrange
    const entry: OwnedEntry = { repoPath: BASHRC };

    // Act & Assert
    expect(owns(entry, BASHRC)).toBe(true);
    expect(owns(entry, `${BASHRC}.linked/`)).toBe(true);
    expect(owns(entry, `${BASHRC}.linked/nested/file`)).toBe(true);
    expect(owns(entry, `${BASHRC}/nested`)).toBe(false);
    expect(owns(entry, `${BASHRC}.bak`)).toBe(false);
  });

  test("should own a dconf entry's path exactly and no linked prefix", () => {
    // Arrange
    const entry: OwnedEntry = { repoPath: DCONF_FILE, type: "dconf" };

    // Act & Assert
    expect(owns(entry, DCONF_FILE)).toBe(true);
    expect(owns(entry, `${DCONF_FILE}.linked/file`)).toBe(false);
    expect(owns(entry, `${DCONF_FILE}/nested`)).toBe(false);
  });

  test("should own a dir entry's folder and not the folder itself", () => {
    // Arrange
    const entry: OwnedEntry = { repoPath: FOLDER, type: "dir" };

    // Act & Assert
    expect(owns(entry, `${FOLDER}/bookmarks.html`)).toBe(true);
    expect(owns(entry, `${FOLDER}/nested/file`)).toBe(true);
    expect(owns(entry, FOLDER)).toBe(false);
    expect(owns(entry, `${FOLDER}.bak`)).toBe(false);
  });

  test("should own each layer path exactly and label it as the entry's path", () => {
    // Arrange
    const entry: OwnedEntry = {
      repoPath: LAYER_OS,
      layerPaths: [LAYER_BASE, LAYER_OS],
    };

    // Act
    const owned = ownedPaths([entry]);

    // Assert
    expect(owned.owns(LAYER_BASE)).toBe(true);
    expect(owned.owns(LAYER_OS)).toBe(true);
    expect(owned.owns(`${LAYER_BASE}.linked/file`)).toBe(false);
    expect(owned.labelOf(LAYER_BASE)).toBe(LAYER_OS);
    expect(owned.labelOf(LAYER_OS)).toBe(LAYER_OS);
    expect(owned.labelOf(BASHRC)).toBe(BASHRC);
  });

  test("should own the paths of every entry in the list", () => {
    // Arrange
    const owned = ownedPaths([
      { repoPath: GITCONFIG },
      { repoPath: FOLDER, type: "dir" },
      { repoPath: DCONF_FILE, type: "dconf" },
    ]);

    // Act & Assert
    expect(owned.owns(GITCONFIG)).toBe(true);
    expect(owned.owns(`${GITCONFIG}.linked/file`)).toBe(true);
    expect(owned.owns(`${FOLDER}/file`)).toBe(true);
    expect(owned.owns(DCONF_FILE)).toBe(true);
    expect(owned.owns(BASHRC)).toBe(false);
  });
});

describe("labelDiff", () => {
  for (const row of TABLE_CASES) {
    test(row.name, () => {
      // Act
      const result = labelDiff({
        owned: ALL_OWNED,
        base: row.base,
        theirs: row.theirs,
        mine: row.mine,
        hasSyncPoint: row.hasSyncPoint,
      });

      // Assert
      expect(result).toEqual(row.expected);
    });
  }

  for (const row of MISSING_CASES) {
    test(row.name, () => {
      // Act
      const result = labelDiff({
        owned: ALL_OWNED,
        base: row.base,
        theirs: row.theirs,
        mine: row.mine,
        hasSyncPoint: row.hasSyncPoint,
      });

      // Assert
      expect(result).toEqual(row.expected);
    });
  }

  for (const row of LAYER_CASES) {
    test(row.name, () => {
      // Act
      const result = labelDiff({
        owned: LAYERED,
        base: row.base,
        theirs: row.theirs,
        mine: row.mine,
        hasSyncPoint: row.hasSyncPoint,
      });

      // Assert
      expect(result).toEqual(row.expected);
    });
  }

  test("should label an entry without layer paths as before", () => {
    // Arrange
    const base = tree({ [BASHRC]: V1 });
    const mine = tree({ [BASHRC]: V2 });

    // Act
    const result = labelDiff({
      owned: ownedPaths([{ repoPath: BASHRC }]),
      base,
      theirs: base,
      mine,
      hasSyncPoint: true,
    });

    // Assert
    expect(result).toEqual([{ label: "OUT", path: BASHRC }]);
  });

  test("should sort the folded labels by code unit", () => {
    // Arrange
    const lowerLayer = `${LOWER}.base`;
    const upperLayer = `${UPPER}.base`;
    const owned = ownedPaths([
      { repoPath: LOWER, layerPaths: [lowerLayer] },
      { repoPath: UPPER, layerPaths: [upperLayer] },
    ]);
    const base = tree({ [lowerLayer]: V1, [upperLayer]: V1 });
    const mine = tree({ [lowerLayer]: V2, [upperLayer]: V2 });

    // Act
    const result = labelDiff({
      owned,
      base,
      theirs: base,
      mine,
      hasSyncPoint: true,
    });

    // Assert
    expect(result).toEqual([
      { label: "OUT", path: UPPER },
      { label: "OUT", path: LOWER },
    ]);
  });

  test("should sort the labels by code unit of the path", () => {
    // Arrange
    const mine = tree({ [LOWER]: V1, [UPPER]: V1 });

    // Act
    const result = labelDiff({
      owned: ALL_OWNED,
      base: tree({}),
      theirs: tree({}),
      mine,
      hasSyncPoint: true,
    });

    // Assert
    expect(result).toEqual([
      { label: "OUT", path: UPPER },
      { label: "OUT", path: LOWER },
    ]);
  });

  test("should label only the paths the owned set holds", () => {
    // Arrange
    const mine = tree({ [BASHRC]: V2, [GITCONFIG]: V2 });
    const base = tree({ [BASHRC]: V1, [GITCONFIG]: V1 });

    // Act
    const result = labelDiff({
      owned: ownedPaths([{ repoPath: BASHRC }]),
      base,
      theirs: base,
      mine,
      hasSyncPoint: true,
    });

    // Assert
    expect(result).toEqual([{ label: "OUT", path: BASHRC }]);
  });
});

describe("diffText", () => {
  test("should print the contract's lines after the title", () => {
    // Arrange
    const labels: readonly DiffLine[] = [
      { label: "IN", path: GITCONFIG },
      { label: "OUT", path: BASHRC },
    ];

    // Act
    const result = diffText(labels, HEADER, false);

    // Assert
    expect(result.lines).toEqual([
      `  Last sync  : ${SHORT} (${DATE})`,
      `  Repo       : origin/master ${REPO_SHORT}`,
      "",
      `  IN         ${GITCONFIG}`,
      `  OUT        ${BASHRC}`,
      "",
      DASHES,
      "",
      "  2 file(s) differ: 1 in, 1 out, 0 both.",
      "  IN: mksync pull takes them. OUT: mksync push sends them.",
      "",
    ]);
    expect(result.exit).toBe(3);
  });

  test("should print the agree line when nothing differs", () => {
    // Act
    const result = diffText([], HEADER, false);

    // Assert
    expect(result.lines).toEqual([
      `  Last sync  : ${SHORT} (${DATE})`,
      `  Repo       : origin/master ${REPO_SHORT}`,
      "",
      DASHES,
      "",
      "  This machine and the repo agree.",
      "",
    ]);
    expect(result.exit).toBe(0);
  });

  test("should warn before the summary when --only is given and no file is labeled", () => {
    // Act
    const result = diffText([], HEADER, true);

    // Assert
    expect(result.lines).toEqual([
      `  Last sync  : ${SHORT} (${DATE})`,
      `  Repo       : origin/master ${REPO_SHORT}`,
      "",
      WARNING,
      DASHES,
      "",
      "  This machine and the repo agree.",
      "",
    ]);
    expect(result.exit).toBe(0);
  });

  test("should not warn when --only is given and a file is labeled", () => {
    // Arrange
    const labels: readonly DiffLine[] = [{ label: "IN", path: GITCONFIG }];

    // Act
    const result = diffText(labels, HEADER, true);

    // Assert
    expect(result.lines).not.toContain(WARNING);
  });

  test("should not warn when --only is not given", () => {
    // Act
    const result = diffText([], HEADER, false);

    // Assert
    expect(result.lines).not.toContain(WARNING);
  });

  test("should print the no-sync-point summary and the run hint", () => {
    // Arrange
    const labels: readonly DiffLine[] = [{ label: "?", path: BASHRC }];

    // Act
    const result = diffText(labels, NO_SYNC_HEADER, false);

    // Assert
    expect(result.lines).toEqual([
      "  Last sync  : none recorded on this machine",
      `  Repo       : HEAD ${REPO_SHORT}`,
      "",
      `  ?          ${BASHRC}`,
      "",
      DASHES,
      "",
      "  1 file(s) differ. No sync is recorded on this machine, so the newer side is unknown.",
      "  Run mksync pull or mksync push once to record one.",
      "",
    ]);
    expect(result.exit).toBe(3);
  });

  test("should count every label in the summary", () => {
    // Arrange
    const labels = diffLines("IN", "IN", "OUT", "BOTH");

    // Act
    const result = diffText(labels, HEADER, false);

    // Assert
    expect(result.lines[result.lines.length - 3]).toBe(
      "  4 file(s) differ: 2 in, 1 out, 1 both.",
    );
  });

  const HINT_CASES: readonly {
    readonly labels: readonly DiffLabel[];
    readonly hint: string;
  }[] = [
    { labels: ["IN"], hint: "  IN: mksync pull takes them." },
    { labels: ["OUT"], hint: "  OUT: mksync push sends them." },
    {
      labels: ["BOTH"],
      hint: "  BOTH: changed on both sides; merge by hand.",
    },
    {
      labels: ["IN", "OUT"],
      hint: "  IN: mksync pull takes them. OUT: mksync push sends them.",
    },
    {
      labels: ["IN", "BOTH"],
      hint: "  IN: mksync pull takes them. BOTH: changed on both sides; merge by hand.",
    },
    {
      labels: ["OUT", "BOTH"],
      hint: "  OUT: mksync push sends them. BOTH: changed on both sides; merge by hand.",
    },
    {
      labels: ["IN", "OUT", "BOTH"],
      hint: "  IN: mksync pull takes them. OUT: mksync push sends them. BOTH: changed on both sides; merge by hand.",
    },
  ];

  for (const hintCase of HINT_CASES) {
    test(`should name only the labels present: ${hintCase.labels.join(", ")}`, () => {
      // Act
      const result = diffText(diffLines(...hintCase.labels), HEADER, false);

      // Assert
      expect(result.lines[result.lines.length - 2]).toBe(hintCase.hint);
    });
  }
});
