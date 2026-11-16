import { describe, expect, test } from "bun:test";
import { strategyFor } from "./strategy.ts";
import type { LayerFile, MergeContext, SplitContext } from "./types.ts";
import {
  DCONF,
  dconfNeedsLoad,
  exportDconf,
  filterKeys,
  parseDconf,
  renderDconf,
} from "./dconf.ts";
import type { DconfSection } from "./dconf.ts";

const APP_DUMP = "[/]\nkeep=1\ndrop=2\n\n[sub]\nx=3\n\n[other]\ny=4\n";
const APP_KEEP = "[/]\nkeep=1\n\n[sub]\nx=3\n";
const SUB_ONLY = "[sub]\nx=3\n";
const GLOB_DUMP = "[/]\nshow-hidden=true\nshown=1\n";
const GLOB_KEEP = "[/]\nshow-hidden=true\n";
const NESTED_DUMP = "[sub/deep]\nz=1\n";
const PROFILE_DUMP =
  "[Profiles/abc]\nlabel='Main'\npalette='Tango'\ncustom-command='/opt/run'\ndefault-container='box'\n";
const PROFILE_KEEP = "[Profiles/abc]\nlabel='Main'\npalette='Tango'\n";
const ORDER_DUMP = "[/]\nsecond=2\nfirst=1\nthird=3\n";
const ORDER_KEEP = "[/]\nfirst=1\nthird=3\n";
const EQUALS_DUMP = "[/]\nkey='a=b'\n";

const BASE_INI = "[/]\na=1\nb=2\n";
const LATER_INI = "[/]\nb=3\nc=4\n";
const MERGED_INI = "[/]\na=1\nb=3\nc=4\n";
const NEW_SECTION_INI = "[sub]\nx=2\n";
const BOTH_SECTIONS_INI = "[/]\na=1\nb=2\n\n[sub]\nx=2\n";
const CHANGED_INI = "[/]\na=1\nb=3\nc=5\n";

const BASE_PATH = "dotfiles/linux/gnome/dconf/app.ini";
const LATER_PATH = "profiles/work-1/gnome/dconf/app.ini";
const WRITE_PATH = "machines/wk1-laptop/gnome/dconf/app.ini";

const LF: MergeContext = { eol: "\n" };

const SPLIT: SplitContext = { writeRepoPath: WRITE_PATH };

const NO_LAYER = { ok: false, error: "no layer holds the file" } as const;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function layer(repoPath: string, text: string): LayerFile {
  return { repoPath, bytes: bytes(text) };
}

function rootSection(keys: readonly string[]): DconfSection {
  return {
    name: "/",
    keys: keys.map((line) => ({ name: line.slice(0, line.indexOf("=")), line })),
  };
}

describe("parseDconf", () => {
  test("keeps sections and keys in the dump's order", () => {
    // Act
    const sections = parseDconf(APP_DUMP);

    // Assert
    expect(sections.map((section) => section.name)).toEqual([
      "/",
      "sub",
      "other",
    ]);
    expect(sections[0]?.keys.map((key) => key.name)).toEqual(["keep", "drop"]);
  });

  test("keeps an equals sign inside a value in the key's line", () => {
    // Act
    const sections = parseDconf(EQUALS_DUMP);

    // Assert
    expect(sections[0]?.keys[0]).toEqual({
      name: "key",
      line: "key='a=b'",
    });
  });
});

describe("renderDconf", () => {
  test("round-trips a dump with one blank line between sections", () => {
    // Act
    const text = renderDconf(parseDconf(APP_DUMP));

    // Assert
    expect(text).toBe(APP_DUMP);
  });

  test("drops a section left with no keys", () => {
    // Arrange
    const sections: readonly DconfSection[] = [
      { name: "/", keys: [] },
      rootSection(["x=3"]),
    ];

    // Act
    const text = renderDconf(sections);

    // Assert
    expect(text).toBe("[/]\nx=3\n");
  });
});

describe("filterKeys", () => {
  test("keeps the whole dump when keys is undefined", () => {
    // Act
    const text = filterKeys(APP_DUMP, undefined);

    // Assert
    expect(text).toBe(APP_DUMP);
  });

  test("keeps the whole dump when keys is empty", () => {
    // Act
    const text = filterKeys(APP_DUMP, []);

    // Assert
    expect(text).toBe(APP_DUMP);
  });

  test("keeps a root key and a matching section and drops the rest", () => {
    // Act
    const text = filterKeys(APP_DUMP, ["keep", "sub/*"]);

    // Assert
    expect(text).toBe(APP_KEEP);
  });

  test("drops the root section when no root key matches", () => {
    // Act
    const text = filterKeys(APP_DUMP, ["sub/*"]);

    // Assert
    expect(text).toBe(SUB_ONLY);
  });

  test("matches a nested section through a glob that crosses the slash", () => {
    // Act
    const text = filterKeys(NESTED_DUMP, ["sub/*"]);

    // Assert
    expect(text).toBe(NESTED_DUMP);
  });

  test("keeps only the keys a prefix glob names", () => {
    // Act
    const text = filterKeys(GLOB_DUMP, ["show-*"]);

    // Assert
    expect(text).toBe(GLOB_KEEP);
  });

  test("keeps every key byte for byte with a single star", () => {
    // Act
    const text = filterKeys(APP_DUMP, ["*"]);

    // Assert
    expect(text).toBe(APP_DUMP);
  });

  test("keeps the dump's order, not the order of the patterns", () => {
    // Act
    const text = filterKeys(ORDER_DUMP, ["third", "first"]);

    // Assert
    expect(text).toBe(ORDER_KEEP);
  });

  test("keeps a profile's listed keys and drops the rest", () => {
    // Act
    const text = filterKeys(PROFILE_DUMP, [
      "Profiles/*/label",
      "Profiles/*/palette",
    ]);

    // Assert
    expect(text).toBe(PROFILE_KEEP);
  });

  test("gives an empty text when nothing matches", () => {
    // Act
    const text = filterKeys(APP_DUMP, ["nothing"]);

    // Assert
    expect(text).toBe("");
  });
});

describe("exportDconf", () => {
  test("is SKIPPED when the filtered dump is empty", () => {
    // Act
    const result = exportDconf(APP_DUMP, ["nothing"], bytes(APP_KEEP));

    // Assert
    expect(result).toEqual({ status: "SKIPPED", text: "" });
  });

  test("is UNCHANGED when the filtered dump matches the repo file", () => {
    // Act
    const result = exportDconf(APP_DUMP, ["keep", "sub/*"], bytes(APP_KEEP));

    // Assert
    expect(result).toEqual({ status: "UNCHANGED", text: APP_KEEP });
  });

  test("is MODIFIED when the repo file holds other bytes", () => {
    // Act
    const result = exportDconf(APP_DUMP, ["keep", "sub/*"], bytes("[/]\nkeep=9\n"));

    // Assert
    expect(result).toEqual({ status: "MODIFIED", text: APP_KEEP });
  });

  test("is ADDED when no repo file exists yet", () => {
    // Act
    const result = exportDconf(APP_DUMP, ["keep", "sub/*"], undefined);

    // Assert
    expect(result).toEqual({ status: "ADDED", text: APP_KEEP });
  });

  test("compares the whole dump when keys is undefined", () => {
    // Act
    const result = exportDconf(APP_DUMP, undefined, bytes(APP_DUMP));

    // Assert
    expect(result).toEqual({ status: "UNCHANGED", text: APP_DUMP });
  });
});

describe("dconfNeedsLoad", () => {
  test("ignores a key only the machine has", () => {
    // Act
    const needsLoad = dconfNeedsLoad("[/]\na=1\n", "[/]\na=1\nb=2\n");

    // Assert
    expect(needsLoad).toBe(false);
  });

  test("is true when a repo key holds a different value", () => {
    // Act
    const needsLoad = dconfNeedsLoad("[/]\na=1\n", "[/]\na=2\n");

    // Assert
    expect(needsLoad).toBe(true);
  });

  test("is true when a repo key is missing from the machine", () => {
    // Act
    const needsLoad = dconfNeedsLoad("[/]\na=1\n", "[/]\nb=2\n");

    // Assert
    expect(needsLoad).toBe(true);
  });

  test("is true when the machine has the key in another section", () => {
    // Act
    const needsLoad = dconfNeedsLoad("[sub]\nx=3\n", "[/]\nx=3\n");

    // Assert
    expect(needsLoad).toBe(true);
  });

  test("is false when every repo key is already set", () => {
    // Act
    const needsLoad = dconfNeedsLoad(
      "[/]\na=1\n\n[sub]\nx=3\n",
      "[/]\na=1\nb=2\n\n[sub]\nx=3\n",
    );

    // Assert
    expect(needsLoad).toBe(false);
  });
});

describe("DCONF strategy", () => {
  test("strategyFor returns it for dconf", () => {
    expect(strategyFor("dconf")).toBe(DCONF);
  });

  test("a merge takes each key from the latest layer that has it", () => {
    // Act
    const result = DCONF.merge(
      [layer(BASE_PATH, BASE_INI), layer(LATER_PATH, LATER_INI)],
      LF,
    );

    // Assert
    expect(result).toEqual({ ok: true, value: bytes(MERGED_INI) });
  });

  test("a merge puts a later layer's new section after the base's", () => {
    // Act
    const result = DCONF.merge(
      [layer(BASE_PATH, BASE_INI), layer(LATER_PATH, NEW_SECTION_INI)],
      LF,
    );

    // Assert
    expect(result).toEqual({ ok: true, value: bytes(BOTH_SECTIONS_INI) });
  });

  test("a merge with no layer is an error", () => {
    // Act
    const result = DCONF.merge([], LF);

    // Assert
    expect(result).toEqual(NO_LAYER);
  });

  test("a split of the repo file's own text makes no change", () => {
    // Act
    const result = DCONF.split(bytes(BASE_INI), [layer(BASE_PATH, BASE_INI)], SPLIT);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        changes: [],
        newSettings: [],
        sideFiles: [],
        label: BASE_PATH,
      },
    });
  });

  test("a split of a changed dump goes to the last layer", () => {
    // Arrange
    const local = bytes(CHANGED_INI);

    // Act
    const result = DCONF.split(
      local,
      [layer(BASE_PATH, BASE_INI), layer(LATER_PATH, LATER_INI)],
      SPLIT,
    );

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        changes: [{ repoPath: LATER_PATH, bytes: local }],
        newSettings: [],
        sideFiles: [],
        label: LATER_PATH,
      },
    });
  });

  test("a split with no layer goes to the write root", () => {
    // Arrange
    const local = bytes(BASE_INI);

    // Act
    const result = DCONF.split(local, [], SPLIT);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        changes: [{ repoPath: WRITE_PATH, bytes: local }],
        newSettings: [],
        sideFiles: [],
        label: WRITE_PATH,
      },
    });
  });

  test("a split of an empty dump never touches the repo file", () => {
    // Act
    const result = DCONF.split(bytes(""), [layer(BASE_PATH, BASE_INI)], SPLIT);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        changes: [],
        newSettings: [],
        sideFiles: [],
        label: BASE_PATH,
      },
    });
  });
});
