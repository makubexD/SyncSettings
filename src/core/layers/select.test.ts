import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseV1 } from "../config/v1.ts";
import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Os,
  Result,
} from "../config/types.ts";
import { pickOs, selectEntries } from "./select.ts";
import type { Layer, SelectScope, SelectedEntry } from "./select.ts";
import type { Profile } from "../config/profile.ts";

const CASE_ROOT = new URL("../../../tests/parity/cases/", import.meta.url);

const PARITY_MODULE = "parity";

const MODULES: ConfigV2["modules"] = {
  git: { description: "Git settings" },
  gnome: { description: "GNOME desktop", os: ["linux"] },
};

const OSES: readonly Os[] = ["windows", "linux", "macos"];

const CASE_ROOTS: readonly string[] = [
  "dotfiles/common/",
  "dotfiles/windows/",
  "dotfiles/linux/",
  "dotfiles/macos/",
];

interface CaseEntry {
  readonly repoPath: string;
  readonly localPath?: string;
  readonly platform: string | readonly string[];
}

interface ParityCase {
  readonly config: { readonly files: readonly CaseEntry[] };
}

function unsupportedOs(value: string): Result<Os, ConfigError> {
  return {
    ok: false,
    error: {
      message: `ERROR: SyncSettings runs on Linux, macOS and Windows; this is ${value}.`,
      code: 1,
    },
  };
}

function parityCase(name: string): ParityCase {
  return JSON.parse(
    readFileSync(new URL(`${name}/case.json`, CASE_ROOT), "utf8"),
  ) as ParityCase;
}

function rootOf(repoPath: string): string {
  const root = CASE_ROOTS.find((candidate) => repoPath.startsWith(candidate));
  if (root === undefined) {
    throw new Error(`no layer root for ${repoPath}`);
  }
  return root;
}

function toOs(name: string): Os {
  if (name === "windows" || name === "linux" || name === "macos") {
    return name;
  }
  throw new Error(`not an OS: ${name}`);
}

function osOf(platform: string | readonly string[]): readonly Os[] | undefined {
  if (typeof platform === "string") {
    return platform === "common" ? undefined : [toOs(platform)];
  }
  return platform.map(toOs);
}

function entryOf(file: CaseEntry): ConfigV2Entry {
  const os = osOf(file.platform);
  return {
    file: file.repoPath.slice(rootOf(file.repoPath).length),
    module: PARITY_MODULE,
    merge: "whole",
    ...(file.localPath !== undefined ? { localPath: file.localPath } : {}),
    ...(os !== undefined ? { os } : {}),
  };
}

function caseV2(name: string): ConfigV2 {
  return {
    schemaVersion: 2,
    modules: { [PARITY_MODULE]: { description: "Parity case" } },
    entries: parityCase(name).config.files.map(entryOf),
  };
}

function configOf(
  entries: readonly ConfigV2Entry[],
  modules: ConfigV2["modules"] = MODULES,
): ConfigV2 {
  return { schemaVersion: 2, modules, entries };
}

function whole(
  file: string,
  extra: Partial<ConfigV2Entry> = {},
): ConfigV2Entry {
  return { file, module: "git", merge: "whole", ...extra };
}

/** A linked folder as the profile or record stores it: a `dir` entry under the
 * layer's `linked/` folder. */
function linkedEntry(name: string, module = "git"): ConfigV2Entry {
  return {
    file: `linked/${name}`,
    module,
    merge: "dir",
    localPath: `~/work-tool-1/${name}`,
  };
}

function profileLayer(repoPath: string): Layer {
  return {
    name: "profile",
    label: "work-1",
    root: "profiles/work-1/",
    repoPath,
  };
}

function machineLayer(repoPath: string): Layer {
  return {
    name: "machine",
    label: "wk1-laptop",
    root: "machines/wk1-laptop/",
    repoPath,
  };
}

function profileOf(
  name: string,
  modules: readonly string[],
  extra: Partial<Profile> = {},
): Profile {
  return {
    name,
    modules,
    values: {},
    destinations: {},
    retired: false,
    ...extra,
  };
}

function selected(
  config: ConfigV2,
  scope: SelectScope,
  files: ReadonlySet<string> = new Set(),
): readonly SelectedEntry[] {
  const result = selectEntries(config, scope, files);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe("pickOs", () => {
  test("SYNC_OS linux picks linux on a Linux host", () => {
    // Act
    const result = pickOs("linux", "linux");

    // Assert
    expect(result).toEqual({ ok: true, value: "linux" });
  });

  test("SYNC_OS macos picks macos on a macOS host", () => {
    expect(pickOs("macos", "darwin")).toEqual({ ok: true, value: "macos" });
  });

  test("SYNC_OS windows picks windows on a Windows host", () => {
    expect(pickOs("windows", "win32")).toEqual({ ok: true, value: "windows" });
  });

  test("SYNC_OS windows stops the run off Windows", () => {
    expect(pickOs("windows", "linux")).toEqual(unsupportedOs("windows"));
    expect(pickOs("windows", "darwin")).toEqual(unsupportedOs("windows"));
  });

  test("SYNC_OS linux or macos stops the run on a Windows host", () => {
    expect(pickOs("linux", "win32")).toEqual(unsupportedOs("linux"));
    expect(pickOs("macos", "win32")).toEqual(unsupportedOs("macos"));
  });

  test("an invalid SYNC_OS stops the run", () => {
    expect(pickOs("freebsd", "linux")).toEqual(unsupportedOs("freebsd"));
  });

  test("an empty SYNC_OS falls back to the host", () => {
    expect(pickOs("", "linux")).toEqual({ ok: true, value: "linux" });
  });

  test("an unset SYNC_OS reads each host's own OS", () => {
    expect(pickOs(undefined, "linux")).toEqual({ ok: true, value: "linux" });
    expect(pickOs(undefined, "darwin")).toEqual({ ok: true, value: "macos" });
    expect(pickOs(undefined, "win32")).toEqual({ ok: true, value: "windows" });
  });

  test("an unknown host stops the run", () => {
    expect(pickOs(undefined, "freebsd")).toEqual(unsupportedOs("freebsd"));
  });
});

describe("selectEntries", () => {
  test("platform-picks-os", () => {
    const config = caseV2("platform-picks-os");
    const expected: Readonly<Record<Os, readonly string[]>> = {
      windows: ["parity/win.conf", "parity/com.conf"],
      linux: ["parity/lin.conf", "parity/com.conf"],
      macos: ["parity/com.conf"],
    };
    const writeRoots: Readonly<Record<Os, readonly string[]>> = {
      windows: ["dotfiles/windows/", "dotfiles/common/"],
      linux: ["dotfiles/linux/", "dotfiles/common/"],
      macos: ["dotfiles/common/"],
    };

    for (const os of OSES) {
      // Act
      const entries = selected(config, { os });

      // Assert
      expect(entries.map((selected) => selected.entry.file)).toEqual([
        ...expected[os],
      ]);
      expect(entries.map((selected) => selected.writeRoot)).toEqual([
        ...writeRoots[os],
      ]);
      expect(entries.map((selected) => selected.source)).toEqual(
        expected[os].map(() => undefined),
      );
    }
  });

  test("platform-list-common", () => {
    const files = parityCase("platform-list-common").config.files;
    const bad = { files };

    // v1 refuses the list holding common before any entry is selected.
    expect(parseV1(JSON.stringify(bad))).toEqual({
      ok: false,
      error: {
        message:
          'ERROR: sync-config.json: entry dotfiles/common/parity/bad.conf needs "platform": "common", "windows", "linux", "macos" or a list of the last three.',
        code: 1,
      },
    });

    // The common entry that is legal applies on every system.
    const [common] = files;
    if (common === undefined) {
      throw new Error("platform-list-common has no files");
    }
    const config = configOf([entryOf(common)]);
    for (const os of OSES) {
      expect(
        selected(config, { os }).map((selected) => selected.entry.file),
      ).toEqual(["parity/ok.conf"]);
    }
  });

  test("should select a linux and macos entry on Linux and macOS but not Windows", () => {
    // Arrange
    const config = configOf([
      entryOf({
        repoPath: "dotfiles/common/m.txt",
        platform: ["linux", "macos"],
      }),
    ]);

    // Act
    const onLinux = selected(config, { os: "linux" });
    const onMacos = selected(config, { os: "macos" });
    const onWindows = selected(config, { os: "windows" });

    // Assert
    expect(onLinux.map((entry) => entry.entry.file)).toEqual(["m.txt"]);
    expect(onMacos.map((entry) => entry.entry.file)).toEqual(["m.txt"]);
    expect(onWindows).toEqual([]);
  });

  test("should skip a windows-only entry on Linux and select it on Windows", () => {
    // Arrange
    const config = configOf([
      entryOf({
        repoPath: "dotfiles/windows/m.txt",
        platform: ["windows"],
      }),
    ]);

    // Act
    const onLinux = selected(config, { os: "linux" });
    const onWindows = selected(config, { os: "windows" });

    // Assert
    expect(onLinux).toEqual([]);
    expect(onWindows.map((entry) => entry.entry.file)).toEqual(["m.txt"]);
    expect(onWindows[0]?.writeRoot).toBe("dotfiles/windows/");
  });

  test("should select a windows and macos entry on Windows", () => {
    // Arrange
    const config = configOf([
      entryOf({
        repoPath: "dotfiles/common/m.txt",
        platform: ["windows", "macos"],
      }),
    ]);

    // Act
    const onWindows = selected(config, { os: "windows" });

    // Assert
    expect(onWindows.map((entry) => entry.entry.file)).toEqual(["m.txt"]);
    expect(onWindows[0]?.writeRoot).toBe("dotfiles/common/");
  });

  test("should ignore a dconf entry on Windows with no line and no error", () => {
    // Arrange
    const config = configOf([
      {
        file: "dconf/app.ini",
        module: "git",
        merge: "dconf",
        dconfPath: "/test/app/",
        os: ["linux"],
      },
    ]);
    const files = new Set(["dotfiles/linux/dconf/app.ini"]);

    // Act
    const result = selectEntries(config, { os: "windows" }, files);

    // Assert
    expect(result).toEqual({ ok: true, value: [] });
  });

  test("module os limits the entry", () => {
    const config = configOf([
      { file: "gnome/settings.ini", module: "gnome", merge: "whole" },
    ]);

    expect(selected(config, { os: "linux" })).toHaveLength(1);
    expect(selected(config, { os: "windows" })).toHaveLength(0);
    expect(selected(config, { os: "macos" })).toHaveLength(0);
  });

  test("an entry with no layer file applies with no source", () => {
    const config = configOf([whole("git/.gitconfig.local", { os: ["linux"] })]);

    const [entry] = selected(config, { os: "linux" });

    expect(entry?.layers).toEqual([]);
    expect(entry?.source).toBeUndefined();
    expect(entry?.writeRoot).toBe("dotfiles/linux/");
  });

  test("the OS layer wins over the base for a whole file", () => {
    const config = configOf([whole("git/.gitconfig.local", { os: ["linux"] })]);
    const files = new Set([
      "dotfiles/common/git/.gitconfig.local",
      "dotfiles/linux/git/.gitconfig.local",
    ]);

    const [entry] = selected(config, { os: "linux" }, files);

    expect(entry?.layers.map((layer) => layer.root)).toEqual([
      "dotfiles/common/",
      "dotfiles/linux/",
    ]);
    expect(entry?.source).toEqual({
      name: "os",
      label: "linux",
      root: "dotfiles/linux/",
      repoPath: "dotfiles/linux/git/.gitconfig.local",
    });
  });

  test("a dir entry is found by a path under its folder", () => {
    const config = configOf([
      {
        file: "nvim",
        module: "git",
        merge: "dir",
        localPath: "~/.config/nvim",
      },
    ]);
    const files = new Set(["dotfiles/linux/nvim/init.lua"]);

    const [entry] = selected(config, { os: "linux" }, files);

    expect(entry?.layers).toEqual([
      {
        name: "os",
        label: "linux",
        root: "dotfiles/linux/",
        repoPath: "dotfiles/linux/nvim",
      },
    ]);
    expect(entry?.source?.repoPath).toBe("dotfiles/linux/nvim");
  });

  test("a json entry with one layer works as a whole file", () => {
    const config = configOf([
      { file: "claude/settings.json", module: "git", merge: "json" },
    ]);
    const files = new Set(["dotfiles/linux/claude/settings.json"]);

    const [entry] = selected(config, { os: "linux" }, files);

    expect(entry?.layers).toHaveLength(1);
    expect(entry?.source?.repoPath).toBe("dotfiles/linux/claude/settings.json");
  });

  test("a json entry with two layers reads the last one as its source", () => {
    const config = configOf([
      { file: "claude/settings.json", module: "git", merge: "json" },
    ]);
    const files = new Set([
      "dotfiles/common/claude/settings.json",
      "dotfiles/linux/claude/settings.json",
    ]);

    const [entry] = selected(config, { os: "linux" }, files);

    expect(entry?.layers.map((layer) => layer.name)).toEqual(["base", "os"]);
    expect(entry?.source?.repoPath).toBe("dotfiles/linux/claude/settings.json");
  });

  test("an import entry with two layers reads the last one as its source", () => {
    const config = configOf([
      { file: "claude/CLAUDE.md", module: "git", merge: "import" },
    ]);
    const files = new Set([
      "dotfiles/common/claude/CLAUDE.md",
      "dotfiles/linux/claude/CLAUDE.md",
    ]);

    const [entry] = selected(config, { os: "linux" }, files);

    expect(entry?.layers.map((layer) => layer.name)).toEqual(["base", "os"]);
    expect(entry?.source?.repoPath).toBe("dotfiles/linux/claude/CLAUDE.md");
  });

  test("with no profile every module is on", () => {
    const config = configOf([
      whole("git/.gitconfig.local", { os: ["linux"] }),
      { file: "gnome/settings.ini", module: "gnome", merge: "whole" },
    ]);

    const files = selected(config, { os: "linux" }).map(
      (entry) => entry.entry.file,
    );

    expect(files).toEqual(["git/.gitconfig.local", "gnome/settings.ini"]);
  });

  test("a profile turns off the modules it doesn't list", () => {
    const config = configOf([
      whole("git/.gitconfig.local", { os: ["linux"] }),
      { file: "gnome/settings.ini", module: "gnome", merge: "whole" },
    ]);
    const profile = profileOf("work-1", ["git"]);

    const files = selected(config, {
      os: "linux",
      profile,
      modules: ["git"],
    }).map((entry) => entry.entry.file);

    expect(files).toEqual(["git/.gitconfig.local"]);
  });

  test("a module whose os excludes this system stays off though listed", () => {
    const config = configOf([
      { file: "gnome/settings.ini", module: "gnome", merge: "whole" },
    ]);
    const profile = profileOf("work-1", ["gnome"]);

    expect(
      selected(config, { os: "windows", profile, modules: ["gnome"] }),
    ).toEqual([]);
  });

  test("four layers come in order with their names and labels", () => {
    const config = configOf([whole("git/.gitconfig.local", { os: ["linux"] })]);
    const profile = profileOf("work-1", ["git"]);
    const files = new Set([
      "dotfiles/common/git/.gitconfig.local",
      "dotfiles/linux/git/.gitconfig.local",
      "profiles/work-1/git/.gitconfig.local",
      "machines/work-1/git/.gitconfig.local",
    ]);

    const [entry] = selected(
      config,
      { os: "linux", profile, machine: "work-1" },
      files,
    );

    expect(entry?.layers.map((layer) => [layer.name, layer.label])).toEqual([
      ["base", "base"],
      ["os", "linux"],
      ["profile", "work-1"],
      ["machine", "work-1"],
    ]);
    expect(entry?.source).toEqual({
      name: "machine",
      label: "work-1",
      root: "machines/work-1/",
      repoPath: "machines/work-1/git/.gitconfig.local",
    });
  });

  test("a profile layer alone is the only layer and the source", () => {
    const config = configOf([whole("git/.gitconfig.local", { os: ["linux"] })]);
    const profile = profileOf("work-1", ["git"]);
    const files = new Set(["profiles/work-1/git/.gitconfig.local"]);

    const [entry] = selected(config, { os: "linux", profile }, files);

    const expectedLayer: Layer = {
      name: "profile",
      label: "work-1",
      root: "profiles/work-1/",
      repoPath: "profiles/work-1/git/.gitconfig.local",
    };
    expect(entry?.layers).toEqual([expectedLayer]);
    expect(entry?.source).toEqual(expectedLayer);
  });

  test("writeRoot is the base root for no os", () => {
    const config = configOf([whole("tmux/.tmux.conf")]);

    expect(selected(config, { os: "linux" })[0]?.writeRoot).toBe(
      "dotfiles/common/",
    );
  });

  test("writeRoot is the base root for more than one system", () => {
    const config = configOf([
      whole("tmux/.tmux.conf", { os: ["linux", "macos"] }),
    ]);

    expect(selected(config, { os: "linux" })[0]?.writeRoot).toBe(
      "dotfiles/common/",
    );
  });

  test("writeRoot is the OS root for one system via the module", () => {
    const config = configOf([
      { file: "gnome/settings.ini", module: "gnome", merge: "whole" },
    ]);

    expect(selected(config, { os: "linux" })[0]?.writeRoot).toBe(
      "dotfiles/linux/",
    );
  });
});

describe("selectEntries with linked folders", () => {
  test("a profile linked entry has one profile slot and no layer without its file", () => {
    // Arrange
    const profile = profileOf("work-1", ["git"], {
      entries: [linkedEntry("scripts")],
    });

    // Act
    const [entry] = selected(configOf([]), { os: "linux", profile });

    // Assert
    expect(entry?.slots).toEqual([
      profileLayer("profiles/work-1/linked/scripts"),
    ]);
    expect(entry?.layers).toEqual([]);
    expect(entry?.source).toBeUndefined();
  });

  test("a profile linked entry gets its layer from a file under its folder", () => {
    // Arrange
    const profile = profileOf("work-1", ["git"], {
      entries: [linkedEntry("scripts")],
    });
    const files = new Set(["profiles/work-1/linked/scripts/a"]);
    const expected = profileLayer("profiles/work-1/linked/scripts");

    // Act
    const [entry] = selected(configOf([]), { os: "linux", profile }, files);

    // Assert
    expect(entry?.layers).toEqual([expected]);
    expect(entry?.source).toEqual(expected);
  });

  test("a profile linked entry writes under the profile root", () => {
    // Arrange
    const profile = profileOf("work-1", ["git"], {
      entries: [linkedEntry("scripts")],
    });

    // Act
    const [entry] = selected(configOf([]), { os: "linux", profile });

    // Assert
    expect(entry?.writeRoot).toBe("profiles/work-1/");
  });

  test("a record linked entry has one machine slot and no layer without its file", () => {
    // Arrange
    const machineEntries = [linkedEntry("tools")];

    // Act
    const [entry] = selected(configOf([]), {
      os: "linux",
      machine: "wk1-laptop",
      machineEntries,
    });

    // Assert
    expect(entry?.slots).toEqual([
      machineLayer("machines/wk1-laptop/linked/tools"),
    ]);
    expect(entry?.layers).toEqual([]);
    expect(entry?.writeRoot).toBe("machines/wk1-laptop/");
  });

  test("a record linked entry gets its layer from a file under its folder", () => {
    // Arrange
    const machineEntries = [linkedEntry("tools")];
    const files = new Set(["machines/wk1-laptop/linked/tools/a"]);
    const expected = machineLayer("machines/wk1-laptop/linked/tools");

    // Act
    const [entry] = selected(
      configOf([]),
      { os: "linux", machine: "wk1-laptop", machineEntries },
      files,
    );

    // Assert
    expect(entry?.layers).toEqual([expected]);
    expect(entry?.source).toEqual(expected);
  });

  test("record entries are ignored without a machine", () => {
    // Act
    const entries = selected(configOf([]), {
      os: "linux",
      machineEntries: [linkedEntry("tools")],
    });

    // Assert
    expect(entries).toEqual([]);
  });

  test("a linked entry whose module is off is dropped", () => {
    // Arrange
    const profile = profileOf("work-1", ["git"], {
      entries: [linkedEntry("settings", "gnome")],
    });

    // Act
    const entries = selected(configOf([]), {
      os: "linux",
      profile,
      modules: ["git"],
    });

    // Assert
    expect(entries).toEqual([]);
  });

  test("config entries come first and read as before", () => {
    // Arrange
    const config = configOf([whole("git/.gitconfig.local", { os: ["linux"] })]);
    const files = new Set([
      "dotfiles/linux/git/.gitconfig.local",
      "profiles/work-1/linked/scripts/a",
    ]);
    const withLinked = profileOf("work-1", ["git"], {
      entries: [linkedEntry("scripts")],
    });

    // Act
    const expected = selected(
      config,
      { os: "linux", profile: profileOf("work-1", ["git"]) },
      files,
    );
    const entries = selected(
      config,
      { os: "linux", profile: withLinked },
      files,
    );

    // Assert
    expect(entries[0]).toEqual(expected[0]);
    expect(entries.map((entry) => entry.entry.file)).toEqual([
      "git/.gitconfig.local",
      "linked/scripts",
    ]);
  });
});
