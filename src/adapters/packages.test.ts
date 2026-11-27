import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { driftLines, parsePackageLists } from "../core/drift.ts";
import type { PackageFile } from "../core/drift.ts";
import {
  driftRoot,
  readDriftIgnore,
  readInstalled,
  readDriftReport,
  readPackageLists,
  runCommand,
} from "./packages.ts";
import type { Run, RunResult } from "./packages.ts";

const MISSING: RunResult = { kind: "missing" };

const FAILED: RunResult = { kind: "failed" };

function ok(stdout: string): RunResult {
  return { kind: "ok", stdout };
}

/** The fake runner: each tool answers from `responses`, anything else is missing. */
function respond(responses: Readonly<Record<string, RunResult>>): Run {
  return (cmd) => responses[cmd] ?? MISSING;
}

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-packages-"));
  tempFolders.push(folder);
  return folder;
}

/** Make every folder on the way to `parts` and return the last one. */
function makeDir(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A version folder with a `lib/node_modules` holding the named folders. */
function installNodeModules(
  home: string,
  version: string,
  names: readonly string[],
): string {
  const nodeDir = makeDir(
    home,
    ".nvm",
    "versions",
    "node",
    version,
    "lib",
    "node_modules",
  );
  for (const name of names) {
    makeDir(nodeDir, name);
  }
  return nodeDir;
}

function textOf(file: PackageFile | undefined): string {
  return file?.content === undefined
    ? ""
    : new TextDecoder().decode(file.content);
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("runCommand", () => {
  test("should report a missing command as missing", () => {
    expect(runCommand("mksync-no-such-command-xyz", [])).toEqual(MISSING);
  });

  test("should report a non-zero exit as failed", () => {
    expect(runCommand("false", [])).toEqual(FAILED);
  });

  test("should return stdout of a successful command", () => {
    expect(runCommand("printf", ["hello\\n"])).toEqual(ok("hello\n"));
  });
});

describe("readInstalled: apt", () => {
  test("should read dpkg-query statuses and apt-mark manual names", () => {
    // Arrange: one non-installed status, one duplicate, and an :arch suffix.
    const home = tempFolder();
    const root = tempFolder();
    const run = respond({
      "dpkg-query": ok(
        "installed foo\nrc removed\ninstalled bar\ninstalled foo\n",
      ),
      "apt-mark": ok("foo:amd64\nmanual-tool\nfoo\n"),
    });

    // Act
    const installed = readInstalled({ home, root, run });

    // Assert
    expect(installed.apt).toEqual({
      present: ["bar", "foo"],
      chosen: ["foo", "manual-tool"],
    });
  });

  test("should report a missing dpkg-query without asking apt-mark", () => {
    // Arrange
    const calls: string[] = [];
    const run: Run = (cmd) => {
      calls.push(cmd);
      return MISSING;
    };

    // Act
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run,
    });

    // Assert
    expect(installed.apt).toEqual({
      skipped: "dpkg-query not installed",
    });
    expect(calls).not.toContain("apt-mark");
  });

  test("should report a failed dpkg-query", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ "dpkg-query": FAILED }),
    });

    expect(installed.apt).toEqual({ skipped: "dpkg-query failed" });
  });

  test("should report a missing apt-mark", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ "dpkg-query": ok("installed foo\n") }),
    });

    expect(installed.apt).toEqual({
      present: ["foo"],
      chosen: { skipped: "apt-mark not installed" },
    });
  });

  test("should report a failed apt-mark", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({
        "dpkg-query": ok("installed foo\n"),
        "apt-mark": FAILED,
      }),
    });

    expect(installed.apt).toEqual({
      present: ["foo"],
      chosen: { skipped: "apt-mark failed" },
    });
  });
});

describe("readInstalled: snap", () => {
  test("should drop the header and the base/snapd rows", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({
        snap: ok(
          [
            "Name     Version  Rev    Tracking       Publisher  Notes",
            "firefox  121.0    1234   latest/stable  mozilla    -",
            "core20   20240111 2182   latest/stable  canonical  base",
            "snapd    2.61     21184  latest/stable  canonical  snapd",
            "gtk-common-themes 1.0 80 latest/stable canonical classic,base",
            "snap-store 1.0 100 latest/stable canonical classic",
            "",
          ].join("\n"),
        ),
      }),
    });

    expect(installed.snap).toEqual({
      present: ["firefox", "snap-store"],
      chosen: ["firefox", "snap-store"],
    });
  });

  test("should report a missing snap", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ snap: MISSING }),
    });

    expect(installed.snap).toEqual({ skipped: "snap not installed" });
  });

  test("should report a failed snap", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ snap: FAILED }),
    });

    expect(installed.snap).toEqual({ skipped: "snap failed" });
  });
});

describe("readInstalled: npm", () => {
  test("should read the newest nvm version in version order", () => {
    // Arrange: lexical order would pick v9; version order picks v24.
    const home = tempFolder();
    installNodeModules(home, "v9.11.2", ["old-nine"]);
    installNodeModules(home, "v24.22.1", ["newest"]);
    installNodeModules(home, "v8.17.0", ["old-eight"]);

    // Act
    const installed = readInstalled({
      home,
      root: tempFolder(),
      run: respond({}),
    });

    // Assert
    expect(installed.npm).toEqual({
      present: ["newest"],
      chosen: ["newest"],
    });
  });

  test("should read @scope/name as one package and skip dotfiles and files", () => {
    // Arrange
    const home = tempFolder();
    const nodeDir = installNodeModules(home, "v20.0.0", [
      "plain",
      "@scope/one",
      "@scope/two",
      ".hidden-folder",
    ]);
    writeText(join(nodeDir, "loose.txt"), "not a package\n");
    writeText(join(nodeDir, "@scope", "README"), "not a package\n");

    // Act
    const installed = readInstalled({
      home,
      root: tempFolder(),
      run: respond({}),
    });

    // Assert
    expect(installed.npm).toEqual({
      present: ["@scope/one", "@scope/two", "plain"],
      chosen: ["@scope/one", "@scope/two", "plain"],
    });
  });

  test("should report a missing nvm folder as nvm not installed", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({}),
    });

    expect(installed.npm).toEqual({ skipped: "nvm not installed" });
  });

  test("should report an empty nvm folder as nvm not installed", () => {
    const home = tempFolder();
    makeDir(home, ".nvm", "versions", "node");

    const installed = readInstalled({
      home,
      root: tempFolder(),
      run: respond({}),
    });

    expect(installed.npm).toEqual({ skipped: "nvm not installed" });
  });
});

describe("readInstalled: pipx and vscode", () => {
  test("should read the first field of pipx list --short", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({
        pipx: ok("black 23.12.0\nisort 5.13.2\nblack 23.12.0\n"),
      }),
    });

    expect(installed.pipx).toEqual({
      present: ["black", "isort"],
      chosen: ["black", "isort"],
    });
  });

  test("should report a missing pipx", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ pipx: MISSING }),
    });

    expect(installed.pipx).toEqual({ skipped: "pipx not installed" });
  });

  test("should report a failed pipx", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ pipx: FAILED }),
    });

    expect(installed.pipx).toEqual({ skipped: "pipx failed" });
  });

  test("should read one extension per line", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({
        code: ok("ms-python.python\nvscodevim.vim\nms-python.python\n"),
      }),
    });

    expect(installed.vscode).toEqual({
      present: ["ms-python.python", "vscodevim.vim"],
      chosen: ["ms-python.python", "vscodevim.vim"],
    });
  });

  test("should report a missing code", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ code: MISSING }),
    });

    expect(installed.vscode).toEqual({ skipped: "code not installed" });
  });

  test("should report a failed code", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({ code: FAILED }),
    });

    expect(installed.vscode).toEqual({ skipped: "code failed" });
  });
});

describe("readInstalled: folders", () => {
  test("should read the font folders and skip loose files", () => {
    const home = tempFolder();
    const fonts = makeDir(home, ".local", "share", "fonts", "NerdFonts");
    makeDir(fonts, "FiraCode");
    makeDir(fonts, "Ubuntu");
    writeText(join(fonts, "notes.txt"), "not a folder\n");

    const installed = readInstalled({
      home,
      root: tempFolder(),
      run: respond({}),
    });

    expect(installed.font).toEqual({
      present: ["FiraCode", "Ubuntu"],
      chosen: ["FiraCode", "Ubuntu"],
    });
  });

  test("should read the extension folders", () => {
    const home = tempFolder();
    const extensions = makeDir(
      home,
      ".local",
      "share",
      "gnome-shell",
      "extensions",
    );
    makeDir(extensions, "u1@example.com");
    writeText(join(extensions, "stray.txt"), "not a folder\n");

    const installed = readInstalled({
      home,
      root: tempFolder(),
      run: respond({}),
    });

    expect(installed.extension).toEqual({
      present: ["u1@example.com"],
      chosen: ["u1@example.com"],
    });
  });

  test("should treat a missing folder manager as empty, not skipped", () => {
    const installed = readInstalled({
      home: tempFolder(),
      root: tempFolder(),
      run: respond({}),
    });

    expect(installed.font).toEqual({ present: [], chosen: [] });
    expect(installed.extension).toEqual({ present: [], chosen: [] });
  });
});

describe("readInstalled: apt sources and keys", () => {
  test("should read every regular file in sources.list.d", () => {
    // Arrange: a directory, a dotfile and a nested file are not sources.
    const root = tempFolder();
    const sources = makeDir(root, "etc", "apt", "sources.list.d");
    writeText(join(sources, "example.sources"), "Types: deb\n");
    writeText(join(sources, "extra.list"), "deb https://example.com/repo\n");
    writeText(join(sources, "notes.txt"), "not a source list\n");
    writeText(join(sources, ".hidden.sources"), "hidden\n");
    makeDir(sources, "sub.sources");

    // Act
    const installed = readInstalled({
      home: tempFolder(),
      root,
      run: respond({}),
    });

    // Assert
    const files = installed["apt-source"].files;
    expect(files.map((file) => file.name)).toEqual([
      "example.sources",
      "extra.list",
      "notes.txt",
    ]);
    expect(textOf(files.find((file) => file.name === "example.sources"))).toBe(
      "Types: deb\n",
    );
  });

  test("should look up keys in usr/share/keyrings before etc/apt/keyrings", () => {
    // Arrange: example.gpg exists in both, so the shared copy wins.
    const root = tempFolder();
    writeText(join(root, "usr", "share", "keyrings", "example.gpg"), "shared");
    writeText(join(root, "etc", "apt", "keyrings", "example.gpg"), "local");
    writeText(join(root, "etc", "apt", "keyrings", "local-only.gpg"), "only");
    writeText(join(root, "usr", "share", "keyrings", "readme.txt"), "not a key");

    // Act
    const installed = readInstalled({
      home: tempFolder(),
      root,
      run: respond({}),
    });

    // Assert
    const files = installed["apt-key"].files;
    expect(files.map((file) => file.name)).toEqual([
      "example.gpg",
      "local-only.gpg",
    ]);
    expect(textOf(files.find((file) => file.name === "example.gpg"))).toBe(
      "shared",
    );
    expect(textOf(files.find((file) => file.name === "local-only.gpg"))).toBe(
      "only",
    );
  });
});

describe("driftRoot", () => {
  test("should read DRIFT_ROOT and default to the real root", () => {
    expect(driftRoot({ DRIFT_ROOT: "/tmp/drift-root" })).toBe(
      "/tmp/drift-root",
    );
    expect(driftRoot({})).toBe("/");
    expect(driftRoot({ DRIFT_ROOT: "" })).toBe("/");
  });
});

describe("readPackageLists and readDriftIgnore", () => {
  test("should read every list text and the source and key files", () => {
    // Arrange
    const folder = tempFolder();
    writeText(join(folder, "apt.txt"), "foo\nmissing\n");
    writeText(join(folder, "deb.txt"), "bar\n");
    writeText(join(folder, "snap.txt"), "firefox\n");
    writeText(join(folder, "npm.txt"), "@scope/pkg\n");
    writeText(join(folder, "pipx.txt"), "black\n");
    writeText(join(folder, "vscode-extensions.txt"), "ms-python.python\n");
    writeText(join(folder, "fonts.txt"), "FiraCode\n");
    writeText(join(folder, "gnome-extensions.txt"), "u1@example.com\n");
    writeText(
      join(folder, "apt-sources", "example.sources"),
      "Types: deb\n",
    );
    writeText(join(folder, "apt-sources", "ignored.txt"), "not a source\n");
    writeText(join(folder, "apt-sources", "keyrings", "example.gpg"), "key");
    writeText(join(folder, "apt-sources", "keyrings", "readme.txt"), "no");

    // Act
    const texts = readPackageLists(folder);

    // Assert
    expect(texts.apt).toBe("foo\nmissing\n");
    expect(texts.deb).toBe("bar\n");
    expect(texts.snap).toBe("firefox\n");
    expect(texts.npm).toBe("@scope/pkg\n");
    expect(texts.pipx).toBe("black\n");
    expect(texts.vscode).toBe("ms-python.python\n");
    expect(texts.font).toBe("FiraCode\n");
    expect(texts.extension).toBe("u1@example.com\n");
    expect(texts.sources?.map((file) => file.name)).toEqual([
      "example.sources",
    ]);
    expect(textOf(texts.sources?.[0])).toBe("Types: deb\n");
    expect(texts.keys?.map((file) => file.name)).toEqual(["example.gpg"]);
    expect(textOf(texts.keys?.[0])).toBe("key");
  });

  test("should leave out a missing packages folder", () => {
    const folder = join(tempFolder(), "absent");

    expect(readPackageLists(folder)).toEqual({});
    expect(readDriftIgnore(folder)).toEqual([]);
  });

  test("should read non-blank drift-ignore lines", () => {
    const folder = tempFolder();
    writeText(
      join(folder, "drift-ignore.txt"),
      "apt baz\n\nsnap firefox\n  \n",
    );

    expect(readDriftIgnore(folder)).toEqual(["apt baz", "snap firefox"]);
  });
});

describe("drift end to end", () => {
  test("should feed driftLines the contract's lines", () => {
    // Arrange: foo and missing are listed, baz is chosen but ignored, qux is
    // chosen and unlisted, and every other manager is quiet.
    const packages = tempFolder();
    writeText(join(packages, "apt.txt"), "foo\nmissing\n");
    writeText(join(packages, "drift-ignore.txt"), "apt baz\n");

    const home = tempFolder();
    installNodeModules(home, "v1.0.0", []);
    const root = tempFolder();
    const run = respond({
      "dpkg-query": ok("installed foo\ninstalled baz\ninstalled qux\n"),
      "apt-mark": ok("foo\nbaz\nqux\n"),
      snap: ok("Name Version Rev Tracking Publisher Notes\n"),
      pipx: ok(""),
      code: ok(""),
    });

    // Act
    const installed = readInstalled({ home, root, run });
    const lists = parsePackageLists(readPackageLists(packages));
    const ignore = readDriftIgnore(packages);
    const lines = driftLines(lists, installed, ignore);

    // Assert
    expect(lines).toEqual([
      "  DRIFT      apt/missing  (in packages/linux/apt.txt, not installed)",
      "  DRIFT      apt/qux  (installed, not in packages/linux/apt.txt)",
    ]);
  });

  test("should compare a real temp DRIFT_ROOT through driftLines", () => {
    // Arrange: the listed source equals the system file, the key does not.
    const packages = tempFolder();
    writeText(join(packages, "apt-sources", "same.sources"), "Types: deb\n");
    writeText(join(packages, "apt-sources", "keyrings", "same.gpg"), "new");

    const root = tempFolder();
    writeText(
      join(root, "etc", "apt", "sources.list.d", "same.sources"),
      "Types: deb\n",
    );
    writeText(join(root, "usr", "share", "keyrings", "same.gpg"), "old");

    const home = tempFolder();
    installNodeModules(home, "v1.0.0", []);
    const run = respond({
      "dpkg-query": ok(""),
      "apt-mark": ok(""),
      snap: ok(""),
      pipx: ok(""),
      code: ok(""),
    });

    // Act
    const installed = readInstalled({
      home,
      root: driftRoot({ DRIFT_ROOT: root }),
      run,
    });
    const lists = parsePackageLists(readPackageLists(packages));
    const lines = driftLines(lists, installed, readDriftIgnore(packages));

    // Assert: the equal source is quiet; the differing key is reported.
    expect(lines).toEqual([
      "  DRIFT      apt-key/same.gpg  (differs from packages/linux/apt-sources)",
    ]);
  });
});

describe("readDriftReport", () => {
  afterEach(() => {
    for (const folder of tempFolders.splice(0)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  /** A repo whose `packages/linux/pipx.txt` lists `listed`, and a home. */
  function pipxRepo(): { readonly repo: string; readonly home: string } {
    const repo = tempFolder();
    writeText(join(repo, "packages", "linux", "pipx.txt"), "listed\n");
    return { repo, home: tempFolder() };
  }

  const PIPX_EXTRA = respond({ pipx: ok("listed 1.0\nextra 2.0\n") });

  test("should give the report's lines on Linux with a packages/linux/ folder", () => {
    // Arrange
    const { repo, home } = pipxRepo();

    // Act
    const lines = readDriftReport(repo, "linux", home, {}, PIPX_EXTRA);

    // Assert
    expect(lines).toContain(
      "  DRIFT      pipx/extra  (installed, not in packages/linux/pipx.txt)",
    );
  });

  test.each<["windows" | "macos"]>([["windows"], ["macos"]])(
    "should give no report on %p",
    (os) => {
      // Arrange
      const { repo, home } = pipxRepo();

      // Act
      const lines = readDriftReport(repo, os, home, {}, PIPX_EXTRA);

      // Assert
      expect(lines).toBeUndefined();
    },
  );

  test("should give no report when the repo has no packages/linux/ folder", () => {
    // Arrange
    const repo = tempFolder();

    // Act
    const lines = readDriftReport(repo, "linux", tempFolder(), {}, PIPX_EXTRA);

    // Assert
    expect(lines).toBeUndefined();
  });
});
