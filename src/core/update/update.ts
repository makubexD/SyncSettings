/**
 * The update plan (contract "Update", decision 5): pure arithmetic over the
 * running version, the release tag and the downloaded file's SHA256. The
 * adapter fetches the release, its `SHA256SUMS` and the program; this module
 * only decides what to do with them. No I/O and no `node:` imports.
 */
import type { Result } from "../config/types.ts";

/** The release assets, keyed as `process.platform`/`process.arch` name them. */
const ASSETS: Readonly<Record<string, string>> = {
  "linux/x64": "mksync-linux-x64",
  "linux/arm64": "mksync-linux-arm64",
  "darwin/arm64": "mksync-darwin-arm64",
  "win32/x64": "mksync-windows-x64.exe",
};

/** One `SHA256SUMS` line: the digest, a space, then a space or `*`, then the
 * name (`*` is sha256sum's binary mode). */
const SUMS_LINE = /^([0-9a-fA-F]{64}) [ *](\S.*)$/;

/** `x.y.z` with an optional leading `v`, as a release tag or `--version`
 * prints it. */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * The release asset for a platform, or `undefined` when the program has no
 * asset for it (`os` and `arch` as `process.platform` and `process.arch` give
 * them).
 */
export function assetName(os: string, arch: string): string | undefined {
  return ASSETS[`${os}/${arch}`];
}

/**
 * `SHA256SUMS` as a map of file name to lowercase digest, or why a line is
 * not one. Empty lines are skipped; CRLF line endings are accepted.
 */
export function parseSums(
  text: string,
): Result<ReadonlyMap<string, string>, string> {
  const sums = new Map<string, string>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.length === 0) {
      continue;
    }
    const match = SUMS_LINE.exec(line);
    const sha = match?.[1];
    const name = match?.[2];
    if (sha === undefined || name === undefined) {
      return {
        ok: false,
        error: `SHA256SUMS line ${index + 1}: expected <64 hex>  <name>`,
      };
    }
    sums.set(name, sha.toLowerCase());
  }
  return { ok: true, value: sums };
}

function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/**
 * Whether `tag` is newer than `current`, comparing `x.y.z` field by field. A
 * version either side that is not `x.y.z` (with an optional `v`) is not newer.
 */
export function isNewer(current: string, tag: string): boolean {
  const from = parseVersion(current);
  const to = parseVersion(tag);
  if (from === undefined || to === undefined) {
    return false;
  }
  if (to.major !== from.major) {
    return to.major > from.major;
  }
  if (to.minor !== from.minor) {
    return to.minor > from.minor;
  }
  return to.patch > from.patch;
}

/** What `mksync update` asks about. `downloadedSha` is absent before a
 * download; a newer release without it cannot be checked, so it refuses. */
export interface UpdateInput {
  readonly current: string;
  readonly latestTag: string;
  readonly expectedSha: string;
  readonly downloadedSha?: string;
}

/** What the update does: nothing, replace the program, or refuse. `to` is the
 * tag without its `v`; `actual` is absent when nothing was downloaded. */
export type UpdatePlan =
  | { readonly kind: "up-to-date" }
  | {
      readonly kind: "replace";
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: "mismatch";
      readonly expected: string;
      readonly actual: string | undefined;
    };

/**
 * What decision 5 describes: a release no newer than `current` needs
 * nothing; a newer one replaces the program when its digest matches
 * `SHA256SUMS`, case-insensitively, and is refused otherwise.
 */
export function planUpdate(input: UpdateInput): UpdatePlan {
  const { current, latestTag, expectedSha, downloadedSha } = input;
  if (!isNewer(current, latestTag)) {
    return { kind: "up-to-date" };
  }
  const to = latestTag.startsWith("v") ? latestTag.slice(1) : latestTag;
  if (
    downloadedSha !== undefined &&
    downloadedSha.toLowerCase() === expectedSha.toLowerCase()
  ) {
    return { kind: "replace", from: current, to };
  }
  return { kind: "mismatch", expected: expectedSha, actual: downloadedSha };
}
