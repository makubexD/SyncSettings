import { describe, expect, test } from "bun:test";
import { driftLines, parsePackageLists } from "./drift.ts";
import type {
  Installed,
  ManagerInstalled,
  PackageFile,
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

const encoder = new TextEncoder();

function file(name: string, content: string): PackageFile {
  return { name, content: encoder.encode(content) };
}

const SOURCE_TEXT = "Types: deb\nURIs: https://example.com/repo\n";

const SOURCE_STALE_TEXT = "Types: deb\nURIs: https://example.com/repoo\n";

const SOURCE_MISSING =
  "  DRIFT      apt-source/example.sources  (in packages/linux/apt-sources, not installed)";

const SOURCE_DIFFERS =
  "  DRIFT      apt-source/example.sources  (differs from packages/linux/apt-sources)";

const SOURCE_EXTRA =
  "  DRIFT      apt-source/example.sources  (installed, not in packages/linux/apt-sources)";

const KEY_MISSING =
  "  DRIFT      apt-key/example.gpg  (in packages/linux/apt-sources, not installed)";

const KEY_DIFFERS =
  "  DRIFT      apt-key/example.gpg  (differs from packages/linux/apt-sources)";

const SNAP_NOT_INSTALLED =
  "  SKIPPED    packages/linux/snap.txt  (snap not installed)";

const SNAP_FAILED = "  SKIPPED    packages/linux/snap.txt  (snap failed)";

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

  test("drift-font-ok", () => {
    // A listed font with a matching folder under NerdFonts is quiet.
    const lists = parsePackageLists({
      font: "NerdFont v1.2.3 0123456789abcdef\n",
    });

    const lines = driftLines(
      lists,
      installedWith({ font: names(["NerdFont"]) }),
      [],
    );

    expect(lists.font).toEqual(["NerdFont"]);
    expect(lines).toEqual([]);
  });

  test("drift-font-missing", () => {
    const lists = parsePackageLists({
      font: "NerdFont v1.2.3 0123456789abcdef\n",
    });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([
      "  DRIFT      font/NerdFont  (in packages/linux/fonts.txt, not installed)",
    ]);
  });

  test("drift-font-extra", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ font: names([], ["Other"]) }),
      [],
    );

    expect(lines).toEqual([
      "  DRIFT      font/Other  (installed, not in packages/linux/fonts.txt)",
    ]);
  });

  test("drift-font-loose-file", () => {
    // The adapter lists folders in NerdFonts only; a loose file such as .uuid
    // is not a package, so the core receives no name.
    const lists = parsePackageLists({ font: "" });

    const lines = driftLines(lists, installedWith({ font: names([]) }), []);

    expect(lines).toEqual([]);
  });

  test("drift-extension-ok", () => {
    const lists = parsePackageLists({
      extension:
        "uuid@example https://github.com/a/b 0123456789abcdef0123456789abcdef01234567\n",
    });

    const lines = driftLines(
      lists,
      installedWith({ extension: names(["uuid@example"]) }),
      [],
    );

    expect(lists.extension).toEqual(["uuid@example"]);
    expect(lines).toEqual([]);
  });

  test("drift-extension-missing", () => {
    const lists = parsePackageLists({
      extension:
        "uuid@example https://github.com/a/b 0123456789abcdef0123456789abcdef01234567\n",
    });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([
      "  DRIFT      extension/uuid@example  (in packages/linux/gnome-extensions.txt, not installed)",
    ]);
  });

  test("drift-extension-extra", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ extension: names([], ["uuid@example"]) }),
      [],
    );

    expect(lines).toEqual([
      "  DRIFT      extension/uuid@example  (installed, not in packages/linux/gnome-extensions.txt)",
    ]);
  });

  test("drift-no-folders", () => {
    // An empty list and a missing folder mean nothing is present: not a
    // skipped tool, and no DRIFT or SKIPPED line.
    const lists = parsePackageLists({ font: "", extension: "" });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([]);
  });

  test("drift-source-ok", () => {
    const lists = parsePackageLists({
      sources: [file("example.sources", SOURCE_TEXT)],
    });

    const lines = driftLines(
      lists,
      installedWith({
        "apt-source": { files: [file("example.sources", SOURCE_TEXT)] },
      }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-source-differs", () => {
    const lists = parsePackageLists({
      sources: [file("example.sources", SOURCE_TEXT)],
    });

    const lines = driftLines(
      lists,
      installedWith({
        "apt-source": { files: [file("example.sources", SOURCE_STALE_TEXT)] },
      }),
      [],
    );

    expect(lines).toEqual([SOURCE_DIFFERS]);
  });

  test("drift-source-missing", () => {
    const lists = parsePackageLists({
      sources: [file("example.sources", SOURCE_TEXT)],
    });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([SOURCE_MISSING]);
  });

  test("drift-source-extra", () => {
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({
        "apt-source": { files: [file("example.sources", SOURCE_TEXT)] },
      }),
      [],
    );

    expect(lines).toEqual([SOURCE_EXTRA]);
  });

  test("drift-source-ignored", () => {
    // The ignore line takes the source out of the "chosen" check, so a system
    // source the repo doesn't list is quiet.
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({
        "apt-source": { files: [file("example.sources", SOURCE_TEXT)] },
      }),
      ["apt-source example.sources"],
    );

    expect(lines).toEqual([]);
  });

  test("drift-key-usr-share", () => {
    // The adapter resolves a key under usr/share/keyrings first; the core sees
    // the file it found and compares the content.
    const lists = parsePackageLists({
      keys: [file("example.gpg", "key\n")],
    });

    const lines = driftLines(
      lists,
      installedWith({ "apt-key": { files: [file("example.gpg", "key\n")] } }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-key-etc-apt", () => {
    // The same key found under etc/apt/keyrings is the same file to the core.
    const lists = parsePackageLists({
      keys: [file("example.gpg", "key\n")],
    });

    const lines = driftLines(
      lists,
      installedWith({ "apt-key": { files: [file("example.gpg", "key\n")] } }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-key-differs", () => {
    const lists = parsePackageLists({
      keys: [file("example.gpg", "key\n")],
    });

    const lines = driftLines(
      lists,
      installedWith({ "apt-key": { files: [file("example.gpg", "kex\n")] } }),
      [],
    );

    expect(lines).toEqual([KEY_DIFFERS]);
  });

  test("drift-key-missing", () => {
    const lists = parsePackageLists({
      keys: [file("example.gpg", "key\n")],
    });

    const lines = driftLines(lists, installedWith(), []);

    expect(lines).toEqual([KEY_MISSING]);
  });

  test("drift-key-stock-ignored", () => {
    // Only listed keys are checked: a stock keyring the repo doesn't hold is
    // never an extra.
    const lists = parsePackageLists({
      keys: [file("example.gpg", "key\n")],
    });

    const lines = driftLines(
      lists,
      installedWith({
        "apt-key": {
          files: [file("example.gpg", "key\n"), file("stock.gpg", "stock\n")],
        },
      }),
      [],
    );

    expect(lines).toEqual([]);
  });

  test("drift-tool-missing", () => {
    // The adapter reports a tool that isn't on PATH as its own skipped note.
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ snap: skipped("snap not installed") }),
      [],
    );

    expect(lines).toEqual([SNAP_NOT_INSTALLED]);
  });

  test("drift-tool-fails", () => {
    // A failing tool is skipped, and the managers after it still report.
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({
        snap: skipped("snap failed"),
        pipx: names([], ["bar"]),
      }),
      [],
    );

    expect(lines).toEqual([
      SNAP_FAILED,
      "  DRIFT      pipx/bar  (installed, not in packages/linux/pipx.txt)",
    ]);
  });

  test("drift-counts-unchanged", () => {
    // The core returns only lines, in the contract's order; the counts, the
    // exit code and the summary notes are the app's and are proved by the
    // step 18 adapter and the shared cases.
    const lists = parsePackageLists({ vscode: "c.d\n" });

    const lines = driftLines(
      lists,
      installedWith({
        apt: names([], ["foo"]),
        snap: skipped("snap failed"),
        pipx: names([], ["bar"]),
      }),
      [],
    );

    expect(lines).toEqual([
      APT_EXTRA_FOO,
      SNAP_FAILED,
      "  DRIFT      pipx/bar  (installed, not in packages/linux/pipx.txt)",
      "  DRIFT      vscode/c.d  (in packages/linux/vscode-extensions.txt, not installed)",
    ]);
    expect(lines.filter((line) => line.startsWith("  DRIFT"))).toHaveLength(3);
  });

  test("drift-writes-nothing", () => {
    // The report is a value: the core only builds lines and never touches the
    // lists or the machine facts it was given.
    const lists = parsePackageLists({
      apt: "foo\n",
      sources: [file("example.sources", SOURCE_TEXT)],
    });
    const installed = installedWith({ apt: names(["foo"]) });
    const listsBefore = structuredClone(lists);
    const installedBefore = structuredClone(installed);

    const first = driftLines(lists, installed, []);
    const second = driftLines(lists, installed, []);

    expect(first).toEqual([SOURCE_MISSING]);
    expect(second).toEqual(first);
    expect(lists).toEqual(listsBefore);
    expect(installed).toEqual(installedBefore);
  });

  test("drift-preview", () => {
    // A preview prints the same lines from the same call; the core has no
    // mode, and writing nothing to the repo is the app's guarantee.
    const lists = parsePackageLists({ apt: "# no apt packages\n" });

    const lines = driftLines(
      lists,
      installedWith({ apt: names([], ["foo"]) }),
      [],
    );

    expect(lines).toEqual([APT_EXTRA_FOO]);
  });

  test("drift-import-silent", () => {
    // The core reports drift whenever the facts differ, so an import's silence
    // comes from the import flow never calling it (step 18).
    const lines = driftLines(
      EMPTY_LISTS,
      installedWith({ apt: names([], ["foo"]) }),
      [],
    );

    expect(lines).toEqual([APT_EXTRA_FOO]);
  });
});
