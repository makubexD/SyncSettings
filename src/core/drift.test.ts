import { describe, expect, test } from "bun:test";
import { driftLines, parsePackageLists } from "./drift.ts";
import type {
  Installed,
  ManagerInstalled,
  PackageLists,
  SkippedTool,
} from "./drift.ts";

const EMPTY_LISTS: PackageLists = {
  apt: [],
  deb: [],
  snap: [],
  npm: [],
  pipx: [],
  vscode: [],
  font: [],
  extension: [],
  sources: [],
  keys: [],
};

const EMPTY_NAMES: ManagerInstalled = { present: [], chosen: [] };

function names(
  present: readonly string[],
  chosen: readonly string[] = present,
): ManagerInstalled {
  return { present, chosen };
}

function skipped(note: string): SkippedTool {
  return { skipped: note };
}

function installedWith(overrides: Partial<Installed> = {}): Installed {
  return {
    apt: EMPTY_NAMES,
    snap: EMPTY_NAMES,
    npm: EMPTY_NAMES,
    pipx: EMPTY_NAMES,
    vscode: EMPTY_NAMES,
    font: EMPTY_NAMES,
    extension: EMPTY_NAMES,
    "apt-source": { files: [] },
    "apt-key": { files: [] },
    ...overrides,
  };
}

const APT_EXTRA_FOO =
  "  DRIFT      apt/foo  (installed, not in packages/linux/apt.txt)";

const APT_MISSING_FOO =
  "  DRIFT      apt/foo  (in packages/linux/apt.txt, not installed)";

describe("package drift", () => {
  test("drift-unreadable-list", () => {
    // An unreadable list file gives awk no text, so it parses as empty; the
    // rest of the report still runs.
    const lists = parsePackageLists({ apt: "" });

    const lines = driftLines(
      lists,
      installedWith({ pipx: names([], ["bar"]) }),
      [],
    );

    expect(lines).toEqual([
      "  DRIFT      pipx/bar  (installed, not in packages/linux/pipx.txt)",
    ]);
  });

  test("drift-no-packages", () => {
    // Without a packages/linux/ folder the app never calls driftLines; empty
    // input prints nothing.
    const lines = driftLines(EMPTY_LISTS, installedWith(), []);

    expect(lines).toEqual([]);
  });

  test("drift-none", () => {
    const lists = parsePackageLists({
      apt: "foo\nbar\n",
      snap: "code classic\n",
      npm: "foo\n",
      pipx: "bar\n",
      vscode: "a.b\n",
    });

    const lines = driftLines(
      lists,
      installedWith({
        apt: names(["foo", "bar"]),
        snap: names(["code"]),
        npm: names(["foo"]),
        pipx: names(["bar"]),
        vscode: names(["a.b"]),
      }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-empty-list", () => {
    const lists = parsePackageLists({ apt: "# nothing installed\n" });

    const lines = driftLines(lists, installedWith(), []);

    expect(lists.apt).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("drift-apt-extra", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ apt: names([], ["foo"]) }),
      [],
    );

    expect(lines).toEqual([APT_EXTRA_FOO]);
  });

  test("drift-apt-missing", () => {
    const lists = parsePackageLists({ apt: "foo\n" });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([APT_MISSING_FOO]);
  });

  test("drift-apt-auto-listed", () => {
    // A listed package marked auto is present but not chosen: it stays quiet.
    const lists = parsePackageLists({ apt: "foo\n" });

    const lines = driftLines(
      lists,
      installedWith({ apt: names(["foo"], []) }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-apt-not-installed-state", () => {
    // The adapter drops dpkg-query rows whose state is not installed, so only
    // the listed name reaches the core.
    const lists = parsePackageLists({ apt: "foo\n" });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([APT_MISSING_FOO]);
  });

  test("drift-apt-ignored", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ apt: names([], ["foo"]) }),
      ["apt foo"],
    );

    expect(lines).toEqual([]);
  });

  test("drift-apt-ignore-other-manager", () => {
    // An ignore line for snap never silences an apt package.
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ apt: names([], ["foo"]) }),
      ["snap foo"],
    );

    expect(lines).toEqual([APT_EXTRA_FOO]);
  });

  test("drift-apt-arch-suffix", () => {
    const lists = parsePackageLists({ apt: "foo\n" });

    const lines = driftLines(
      lists,
      installedWith({ apt: names(["foo"], ["foo:i386"]) }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-deb-listed", () => {
    const lists = parsePackageLists({
      deb: "foo https://example.com/foo.deb 0123456789abcdef\n",
    });

    const lines = driftLines(
      lists,
      installedWith({ apt: names(["foo"], ["foo"]) }),
      [],
    );

    expect(lists.deb).toEqual(["foo"]);
    expect(lines).toEqual([]);
  });

  test("drift-deb-missing", () => {
    const lists = parsePackageLists({
      deb: "foo https://example.com/foo.deb 0123456789abcdef\n",
    });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([
      "  DRIFT      apt/foo  (in packages/linux/deb.txt, not installed)",
    ]);
  });

  test("drift-snap-notes", () => {
    // The adapter leaves out rows noted base or snapd; they are never names.
    const lists = parsePackageLists({ snap: "foo\nbar\n" });

    const lines = driftLines(
      lists,
      installedWith({ snap: names(["foo", "bar"]) }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-snap-options", () => {
    const lists = parsePackageLists({ snap: "foo classic channel=v1/stable\n" });

    const lines = driftLines(
      lists,
      installedWith({ snap: names(["foo"]) }),
      [],
    );

    expect(lists.snap).toEqual(["foo"]);
    expect(lines).toEqual([]);
  });

  test("drift-snap-extra", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ snap: names([], ["foo"]) }),
      [],
    );

    expect(lines).toEqual([
      "  DRIFT      snap/foo  (installed, not in packages/linux/snap.txt)",
    ]);
  });

  test("drift-snap-missing", () => {
    const lists = parsePackageLists({ snap: "foo\n" });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([
      "  DRIFT      snap/foo  (in packages/linux/snap.txt, not installed)",
    ]);
  });

  test("drift-npm-extra", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ npm: names([], ["foo"]) }),
      [],
    );

    expect(lines).toEqual([
      "  DRIFT      npm/foo  (installed, not in packages/linux/npm.txt)",
    ]);
  });

  test("drift-npm-scoped", () => {
    const lists = parsePackageLists({ npm: "@a/b\n" });

    const lines = driftLines(
      lists,
      installedWith({ npm: names(["@a/b"]) }),
      [],
    );

    expect(lists.npm).toEqual(["@a/b"]);
    expect(lines).toEqual([]);
  });

  test("drift-npm-newest", () => {
    // The adapter reads only the newest nvm version; the core compares the
    // names it receives.
    const lists = parsePackageLists({ npm: "y\n" });

    const lines = driftLines(
      lists,
      installedWith({ npm: names(["y"]) }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-npm-hidden", () => {
    // A dotfile such as .bin is not a package, so the adapter passes no name.
    const lines = driftLines(EMPTY_LISTS, installedWith(), []);

    expect(lines).toEqual([]);
  });

  test("drift-npm-no-call", () => {
    // The core never runs npm: it compares the folder names the adapter read.
    const lists = parsePackageLists({ npm: "foo\n" });

    const lines = driftLines(
      lists,
      installedWith({ npm: names(["foo"]) }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-npm-no-nvm", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({
        npm: skipped("nvm not installed"),
        apt: names([], ["foo"]),
      }),
      [],
    );

    expect(lines).toEqual([
      APT_EXTRA_FOO,
      "  SKIPPED    packages/linux/npm.txt  (nvm not installed)",
    ]);
  });

  test("drift-pipx", () => {
    const lists = parsePackageLists({ pipx: "foo\n" });

    const lines = driftLines(
      lists,
      installedWith({ pipx: names(["foo"]) }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-vscode", () => {
    const lists = parsePackageLists({ vscode: "c.d\n" });

    const lines = driftLines(
      lists,
      installedWith({ vscode: names(["a.b"]) }),
      [],
    );

    expect(lines).toEqual([
      "  DRIFT      vscode/c.d  (in packages/linux/vscode-extensions.txt, not installed)",
      "  DRIFT      vscode/a.b  (installed, not in packages/linux/vscode-extensions.txt)",
    ]);
  });
});
