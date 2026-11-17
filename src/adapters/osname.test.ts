import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusLines } from "../core/front/status.ts";
import type { StatusFacts } from "../core/front/status.ts";
import { readOsName } from "./osname.ts";

/** The `sw_vers -productVersion` answer the stub prints. */
const MACOS_VERSION = "26.7.2";

/** The `PRETTY_NAME` the Linux os-release holds. */
const PRETTY_NAME = "Test OS 1";

/** The name a later `PRETTY_NAME` line replaces it with. */
const LATER_PRETTY_NAME = "Test OS 2";

/** What the contract falls back to when the file can't be read. */
const UNKNOWN = "unknown";

/** The one command `readOsName` runs on macOS, as the old case stubs it. */
const SW_VERS_SCRIPT = `#!/bin/sh
printf '%s\\n' "${MACOS_VERSION}"
`;

/** This module, so a fresh process imports the code under test, not a copy. */
const OSNAME_MODULE = join(import.meta.dir, "osname.ts");

/** Every fact the status header reads, so a test checks only the OS label. */
const STATUS_FACTS: StatusFacts = {
  os: "linux",
  osName: PRETTY_NAME,
  repo: "/home/user/SyncSettings",
  origin: { kind: "fetched", updates: 0 },
  unsent: 0,
  machine: { kind: "match" },
  pullOnly: false,
  linked: [],
};

const ORIGINAL_PATH = process.env.PATH;

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-osname-"));
  tempFolders.push(folder);
  return folder;
}

function writeOsRelease(contents: string): string {
  const path = join(tempFolder(), "os-release");
  writeFileSync(path, contents);
  return path;
}

/** A folder holding only an executable `sw_vers`, put first on `PATH`. */
function stubMacos(): void {
  const folder = tempFolder();
  const path = join(folder, "sw_vers");
  writeFileSync(path, SW_VERS_SCRIPT);
  chmodSync(path, 0o755);
  process.env.PATH = folder;
}

/** The `SyncSettings` header line the status prints for `os` and `name`. */
function header(os: StatusFacts["os"], osName: string): string | undefined {
  return statusLines({ ...STATUS_FACTS, os, osName }).find((line) =>
    line.startsWith("  SyncSettings  "),
  );
}

/**
 * `readOsName("macos", …)` in a fresh Bun process. Bun resolves a spawned
 * command against the `PATH` the process started with, so the `sw_vers` stub
 * only reaches `commandLine` when the process starts under the stubbed `PATH`.
 */
function readMacosName(): string {
  const script = `import { readOsName } from ${JSON.stringify(OSNAME_MODULE)}; process.stdout.write(readOsName("macos", process.env));`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `the child exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

afterEach(() => {
  if (ORIGINAL_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("readOsName macOS label (front-macos-label)", () => {
  test("reads the sw_vers version", () => {
    stubMacos();

    expect(readMacosName()).toBe(MACOS_VERSION);
  });

  test("the status header shows macos (26.7.2)", () => {
    stubMacos();
    const osName = readMacosName();

    expect(header("macos", osName)).toBe("  SyncSettings  macos (26.7.2)");
  });
});

describe("readOsName Linux label (sync-status-os-name)", () => {
  test("reads PRETTY_NAME, unquoted", () => {
    const path = writeOsRelease(`PRETTY_NAME="${PRETTY_NAME}"\nID=debian\n`);

    expect(readOsName("linux", { SYNC_OS_RELEASE: path })).toBe(PRETTY_NAME);
  });

  test("the status header shows linux (Test OS 1)", () => {
    const path = writeOsRelease(`PRETTY_NAME="${PRETTY_NAME}"\nID=debian\n`);
    const osName = readOsName("linux", { SYNC_OS_RELEASE: path });

    expect(header("linux", osName)).toBe("  SyncSettings  linux (Test OS 1)");
  });

  test("the last PRETTY_NAME wins", () => {
    const path = writeOsRelease(
      `PRETTY_NAME="${PRETTY_NAME}"\nPRETTY_NAME="${LATER_PRETTY_NAME}"\n`,
    );

    expect(readOsName("linux", { SYNC_OS_RELEASE: path })).toBe(
      LATER_PRETTY_NAME,
    );
  });

  test("a missing os-release is unknown", () => {
    const path = join(tempFolder(), "missing-os-release");

    expect(readOsName("linux", { SYNC_OS_RELEASE: path })).toBe(UNKNOWN);
  });
});
