import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assetName } from "../core/update/update.ts";
import { executeUpdate } from "./update.ts";
import type { UpdateDeps } from "./update.ts";

const RELEASE_TAG = "v9.9.9";

const RELEASE_VERSION = "9.9.9";

const CURRENT_OLDER = "0.9.0";

const OLD_PROGRAM = "#!/bin/sh\necho old mksync\n";

const NEW_PROGRAM = "#!/bin/sh\necho new mksync\n";

/** A runtime that runs the source, as `process.execPath` names it then. */
const RUNTIME_NAME = "bun";

/** The runtime's bytes, which an update must leave alone. */
const RUNTIME_BYTES = "#!/bin/sh\necho bun\n";

const WRONG_DIGEST = "f".repeat(64);

/** The refusal a clone launcher gets. */
const LAUNCHER_ERROR =
  "ERROR: mksync runs from the clone here; update it with git pull.\n";

/** Every temporary folder a case made, removed after it. */
const folders: string[] = [];

/** The release asset this machine would update to, or the reason a test cannot
 * run on this platform. */
function releaseAsset(): string {
  const asset = assetName(process.platform, process.arch);
  if (asset === undefined) {
    throw new Error(`no mksync asset for ${process.platform}-${process.arch}`);
  }
  return asset;
}

interface FixtureOptions {
  readonly current: string;
  /** The program bytes the release holds; `NEW_PROGRAM` by default. */
  readonly assetBytes?: string;
  /** The digest `SHA256SUMS` lists; the asset's own by default. */
  readonly sumsDigest?: string;
  /** Set `MKSYNC_LAUNCHER=1`, as the clone launchers do. */
  readonly launcher?: boolean;
  /** What the attestation stub answers. */
  readonly verification?: "skipped" | "verified" | "failed";
}

interface Fixture {
  readonly execPath: string;
  readonly deps: UpdateDeps;
}

/** A release folder over `file://`, a program file to replace, and the deps
 * that point the flow at both. */
function makeFixture(options: FixtureOptions): Fixture {
  const asset = releaseAsset();
  const releaseRoot = mkdtempSync(join(tmpdir(), "mksync-update-release-"));
  const installRoot = mkdtempSync(join(tmpdir(), "mksync-update-install-"));
  folders.push(releaseRoot, installRoot);
  const downloadFolder = join(releaseRoot, "download", RELEASE_TAG);
  mkdirSync(downloadFolder, { recursive: true });
  const assetBytes = options.assetBytes ?? NEW_PROGRAM;
  writeFileSync(join(releaseRoot, "latest"), `${RELEASE_TAG}\n`);
  writeFileSync(join(downloadFolder, asset), assetBytes);
  const digest =
    options.sumsDigest ?? createHash("sha256").update(assetBytes).digest("hex");
  writeFileSync(join(downloadFolder, "SHA256SUMS"), `${digest}  ${asset}\n`);
  const execPath = join(installRoot, "mksync");
  writeFileSync(execPath, OLD_PROGRAM, { mode: 0o755 });
  const env: Record<string, string | undefined> = {
    MKSYNC_RELEASE_URL: pathToFileURL(releaseRoot).href,
  };
  if (options.launcher === true) {
    env.MKSYNC_LAUNCHER = "1";
  }
  return {
    execPath,
    deps: {
      current: options.current,
      execPath,
      platform: process.platform,
      arch: process.arch,
      env,
      verifyAttestation: async () => options.verification ?? "skipped",
    },
  };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("executeUpdate", () => {
  test("should print the up-to-date line and touch nothing when the release is not newer", async () => {
    // Arrange
    const fixture = makeFixture({ current: RELEASE_VERSION });

    // Act
    const result = await executeUpdate(fixture.deps);

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: `mksync ${RELEASE_VERSION} is up to date.\n`,
      stderr: "",
    });
    expect(readFileSync(fixture.execPath, "utf8")).toBe(OLD_PROGRAM);
  });

  test("should replace the program and print its line when the release is newer", async () => {
    // Arrange
    const fixture = makeFixture({ current: CURRENT_OLDER });

    // Act
    const result = await executeUpdate(fixture.deps);

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: `mksync updated: ${CURRENT_OLDER} -> ${RELEASE_VERSION}.\n`,
      stderr: "",
    });
    expect(readFileSync(fixture.execPath, "utf8")).toBe(NEW_PROGRAM);
    expect(existsSync(`${fixture.execPath}.new`)).toBe(false);
  });

  test("should refuse a checksum mismatch and leave the program alone", async () => {
    // Arrange
    const asset = releaseAsset();
    const fixture = makeFixture({
      current: CURRENT_OLDER,
      sumsDigest: WRONG_DIGEST,
    });

    // Act
    const result = await executeUpdate(fixture.deps);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `ERROR: ${asset}: checksum does not match SHA256SUMS; nothing changed.\n`,
    );
    expect(readFileSync(fixture.execPath, "utf8")).toBe(OLD_PROGRAM);
    expect(existsSync(`${fixture.execPath}.new`)).toBe(false);
  });

  test("should refuse under a clone launcher before reading the release", async () => {
    // Arrange
    const fixture = makeFixture({ current: CURRENT_OLDER, launcher: true });

    // Act
    const result = await executeUpdate(fixture.deps);

    // Assert
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: LAUNCHER_ERROR,
    });
    expect(readFileSync(fixture.execPath, "utf8")).toBe(OLD_PROGRAM);
  });

  test("should refuse when the runtime runs the source, before reading the release", async () => {
    // Arrange
    const fixture = makeFixture({ current: CURRENT_OLDER });
    const runtimePath = join(dirname(fixture.execPath), RUNTIME_NAME);
    writeFileSync(runtimePath, RUNTIME_BYTES, { mode: 0o755 });
    const deps = { ...fixture.deps, execPath: runtimePath };

    // Act
    const result = await executeUpdate(deps);

    // Assert
    expect(result).toEqual({ code: 2, stdout: "", stderr: LAUNCHER_ERROR });
    expect(readFileSync(runtimePath, "utf8")).toBe(RUNTIME_BYTES);
  });

  test("should refuse a failed attestation and leave the program alone", async () => {
    // Arrange
    const asset = releaseAsset();
    const fixture = makeFixture({
      current: CURRENT_OLDER,
      verification: "failed",
    });

    // Act
    const result = await executeUpdate(fixture.deps);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `ERROR: ${asset}: attestation check failed; nothing changed.\n`,
    );
    expect(readFileSync(fixture.execPath, "utf8")).toBe(OLD_PROGRAM);
    expect(existsSync(`${fixture.execPath}.new`)).toBe(false);
  });
});
