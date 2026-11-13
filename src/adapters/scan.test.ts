import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigV2 } from "../core/config/types.ts";
import { readScan } from "./scan.ts";

const EXECUTABLE_MODE = 0o755;

const FILE_MODE = 0o644;

const TEST_HOSTNAME = "wk1-laptop";

const TEST_DOMAIN = "corp.example.com";

const TEST_EMAIL = "user@example.com";

const STUB_SCRIPT = "#!/bin/sh\nexit 0\n";

/** The contract's tool list, so each case can name the missing ones. */
const ALL_TOOLS = [
  "git",
  "gh",
  "jq",
  "code",
  "claude",
  "tmux",
  "starship",
  "wezterm",
  "htop",
  "rtk",
] as const;

const EMPTY_CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {},
  entries: [],
};

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-scan-"));
  tempFolders.push(folder);
  return folder;
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

/** An environment holding only what the case sets, so the host's own
 * `HOME`, `PATH` and `SYNC_*` variables cannot leak in. */
function isolatedEnv(
  home: string,
  overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: "",
    GIT_CONFIG_NOSYSTEM: "1",
    ...overrides,
  };
}

/** Write a runnable stub under `path`, as an installed tool would be. */
function writeExecutable(path: string): void {
  writeFileSync(path, STUB_SCRIPT, { mode: EXECUTABLE_MODE });
  chmodSync(path, EXECUTABLE_MODE);
}

function missingOf(found: readonly string[]): readonly string[] {
  return ALL_TOOLS.filter((tool) => !found.includes(tool));
}

describe("readScan", () => {
  test("should lower the hostname and take SYNC_DOMAIN and SYNC_TOOLS as given", async () => {
    const scan = await readScan(
      isolatedEnv(tempFolder(), {
        SYNC_HOSTNAME: TEST_HOSTNAME.toUpperCase(),
        SYNC_DOMAIN: TEST_DOMAIN,
        SYNC_TOOLS: "git,jq,rtk",
      }),
      "linux",
      tempFolder(),
      EMPTY_CONFIG,
    );

    expect(scan.hostname).toBe(TEST_HOSTNAME);
    expect(scan.domain).toBe(TEST_DOMAIN);
    expect(scan.tools.found).toEqual(["git", "jq", "rtk"]);
    expect(scan.tools.missing).toEqual(missingOf(["git", "jq", "rtk"]));
  });

  test("should ignore a SYNC_TOOLS name that is not on the contract list", async () => {
    const scan = await readScan(
      isolatedEnv(tempFolder(), { SYNC_TOOLS: "not-a-tool,jq" }),
      "linux",
      tempFolder(),
      EMPTY_CONFIG,
    );

    expect(scan.tools.found).toEqual(["jq"]);
    expect(scan.tools.missing).toEqual(missingOf(["jq"]));
  });

  test("should find the executable stubs on PATH and miss a non-executable file", async () => {
    const bin = tempFolder();
    writeExecutable(join(bin, "git"));
    writeExecutable(join(bin, "jq"));
    writeFileSync(join(bin, "rtk"), STUB_SCRIPT, { mode: FILE_MODE });

    const scan = await readScan(
      isolatedEnv(tempFolder(), { PATH: bin }),
      "linux",
      tempFolder(),
      EMPTY_CONFIG,
    );

    expect(scan.tools.found).toEqual(["git", "jq"]);
    expect(scan.tools.missing).toEqual(missingOf(["git", "jq"]));
  });

  test("should report no git email when HOME holds no global config", async () => {
    const home = tempFolder();

    const scan = await readScan(
      isolatedEnv(home, { PATH: process.env.PATH }),
      "linux",
      home,
      EMPTY_CONFIG,
    );

    expect(scan.gitEmail).toBeNull();
  });

  test("should read the global git email from HOME's .gitconfig", async () => {
    const home = tempFolder();
    writeFileSync(
      join(home, ".gitconfig"),
      `[user]\n\temail = ${TEST_EMAIL}\n`,
    );

    const scan = await readScan(
      isolatedEnv(home, { PATH: process.env.PATH }),
      "linux",
      home,
      EMPTY_CONFIG,
    );

    expect(scan.gitEmail).toBe(TEST_EMAIL);
  });

  test("should count only this OS's entries, and how many already exist", async () => {
    const home = tempFolder();
    writeFileSync(join(home, "present"), "value");
    const config: ConfigV2 = {
      schemaVersion: 2,
      modules: {
        shell: { description: "Shell", os: ["linux"] },
        terminal: { description: "Windows terminal" },
      },
      entries: [
        {
          file: "present",
          module: "shell",
          merge: "whole",
          localPath: "~/present",
        },
        {
          file: "absent",
          module: "shell",
          merge: "whole",
          localPath: "~/absent",
        },
        {
          file: "other",
          module: "terminal",
          merge: "whole",
          localPath: "~/other",
          os: ["windows"],
        },
      ],
    };

    const scan = await readScan(isolatedEnv(home, {}), "linux", home, config);

    expect(scan.files).toEqual({ existing: 1, total: 2 });
  });
});
