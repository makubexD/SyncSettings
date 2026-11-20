import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "./process.ts";
import { download, latestTag, releaseBase, useGh } from "./release.ts";

const TAG = "v9.9.9";

const ASSET = "mksync-linux-x64";

const ASSET_BYTES = "the release asset";

const NOT_FOUND = "HTTP 404: Not Found";

/** The `gh` stub writes each argv to this name inside its own folder. */
const LOG_NAME = "gh.log";

/** The `gh` stub writes the `-D` folder of a download to this name. */
const DIR_LOG_NAME = "gh.dirs";

const originalGh = process.env.GH;

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-release-"));
  tempFolders.push(folder);
  return folder;
}

interface Stub {
  readonly log: string;
  readonly dirLog: string;
}

/**
 * Name a temp `gh` stub through `GH`, as `gh.ts` resolves the binary. The stub
 * logs every argv to `log`, then runs `script`, which may log a download
 * folder to `dirLog`. `run` resolves the command through the `GH` override
 * rather than a PATH the test changes, so a PATH stub would not be seen.
 */
function installStub(script: (dirLog: string) => string): Stub {
  const folder = tempFolder();
  const log = join(folder, LOG_NAME);
  const dirLog = join(folder, DIR_LOG_NAME);
  writeFileSync(log, "");
  writeFileSync(dirLog, "");
  const body =
    `#!/usr/bin/env bash\n` +
    `printf '%s\\n' "$*" >> '${log}'\n` +
    `${script(dirLog)}\n`;
  writeFileSync(join(folder, "gh"), body, { mode: 0o755 });
  process.env.GH = join(folder, "gh");
  return { log, dirLog };
}

/** A signed-in stub: `auth status` succeeds, `release view` prints the tag,
 * and `release download` writes the asset into the `-D` folder. */
function signedInStub(): Stub {
  return installStub(
    (dirLog) => `if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "release" ] && [ "$2" = "view" ]; then printf '%s\\n' '${TAG}'; exit 0; fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  name=''
  dir=''
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -p) shift; name="$1" ;;
      -D) shift; dir="$1" ;;
    esac
    shift
  done
  printf '%s\\n' "$dir" >> '${dirLog}'
  printf '%s' '${ASSET_BYTES}' > "$dir/$name"
  exit 0
fi
exit 1`,
  );
}

/** A release folder served over `file://`, with `latest` and the asset. */
function makeReleaseFolder(): {
  base: string;
  env: Record<string, string | undefined>;
} {
  const root = tempFolder();
  const downloadFolder = join(root, "download", TAG);
  mkdirSync(downloadFolder, { recursive: true });
  writeFileSync(join(root, "latest"), `${TAG}\n`);
  writeFileSync(join(downloadFolder, ASSET), ASSET_BYTES);
  const raw = pathToFileURL(root).href;
  return {
    base: releaseBase({ MKSYNC_RELEASE_URL: raw }),
    env: { MKSYNC_RELEASE_URL: raw },
  };
}

afterEach(() => {
  if (originalGh === undefined) {
    delete process.env.GH;
  } else {
    process.env.GH = originalGh;
  }
  for (const folder of tempFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("release adapter over gh", () => {
  test("should read the tag and asset through gh when signed in", async () => {
    // Arrange
    const { dirLog } = signedInStub();
    const base = releaseBase({});

    // Act
    const tag = await latestTag(base, {});
    const asset = await download(base, TAG, ASSET, {});

    // Assert
    expect(tag).toEqual({ ok: true, value: TAG });
    expect(asset.ok).toBe(true);
    if (asset.ok) {
      expect(decode(asset.value)).toBe(ASSET_BYTES);
    }
    const folder = readFileSync(dirLog, "utf8").trim();
    expect(folder).not.toBe("");
    expect(existsSync(folder)).toBe(false);
  });

  test("should report the gh stderr line when the release download fails", async () => {
    // Arrange
    installStub(
      () => `if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "release" ] && [ "$2" = "view" ]; then printf '%s\\n' '${TAG}'; exit 0; fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then printf '%s\\n' '${NOT_FOUND}' >&2; exit 1; fi
exit 1`,
    );
    const base = releaseBase({});

    // Act
    const result = await download(base, TAG, ASSET, {});

    // Assert
    expect(result).toEqual({ ok: false, error: NOT_FOUND });
  });

  test("should not use gh when gh is signed out", async () => {
    // Arrange
    const { log } = installStub(
      () => 'if [ "$1" = "auth" ]; then exit 1; fi\nexit 1',
    );

    // Act
    const use = await useGh({});

    // Assert
    expect(use).toBe(false);
    expect(readFileSync(log, "utf8").trim()).toBe("auth status");
  });

  test("should keep the file:// fetch path and never run gh", async () => {
    // Arrange
    const { log } = installStub(() => "exit 1");
    const { base, env } = makeReleaseFolder();

    // Act
    const use = await useGh(env);
    const tag = await latestTag(base, env);
    const asset = await download(base, TAG, ASSET, env);

    // Assert
    expect(use).toBe(false);
    expect(tag).toEqual({ ok: true, value: TAG });
    expect(asset.ok).toBe(true);
    if (asset.ok) {
      expect(decode(asset.value)).toBe(ASSET_BYTES);
    }
    expect(readFileSync(log, "utf8")).toBe("");
  });
});
