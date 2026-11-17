/**
 * The release adapter: where the latest release tag lives and how to download
 * one of its assets. One base URL (`MKSYNC_RELEASE_URL`, a GitHub release page
 * by default) serves both a real release over http(s) and a test folder over
 * `file://`, so a test never reaches the network.
 *
 * Failure is a result, never an exception: a broken link, a non-2xx answer and
 * a missing file are errors the contract can print.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Result } from "../core/config/types.ts";

/** Where a released program is downloaded from when the environment names no
 * other base. */
const DEFAULT_RELEASE_BASE =
  "https://github.com/makubexD/SyncSettings/releases";

/** How long the lookup and each download may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 30_000;

/** The segment a GitHub release URL carries before its tag. */
const TAG_SEGMENT = "tag";

/**
 * The release base URL: `MKSYNC_RELEASE_URL` when it holds a value, otherwise
 * the public GitHub release page. One trailing slash is never part of the
 * base, so joining a path never doubles it.
 */
export function releaseBase(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.MKSYNC_RELEASE_URL;
  const base =
    configured === undefined || configured === ""
      ? DEFAULT_RELEASE_BASE
      : configured;
  return base.replace(/\/+$/, "");
}

/** A thrown value as the one-line reason the caller prints. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch `url`, following redirects under the adapter's time limit; a
 * non-2xx answer is an error naming its status. */
async function get(url: string): Promise<Result<Response, string>> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true, value: response };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

/** The release tag at the end of a GitHub `/tag/` URL, if the final URL is
 * one; `undefined` for any other page. */
function tagFromUrl(finalUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    // A URL the runtime will not parse cannot name a release tag.
    return undefined;
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2 || segments[segments.length - 2] !== TAG_SEGMENT) {
    return undefined;
  }
  return segments[segments.length - 1];
}

/**
 * The latest release tag. Over `file://` a `latest` file next to the release
 * folder holds it; over http(s) the `<base>/latest` redirect is followed and
 * the tag is read from the `/tag/` URL it lands on.
 */
export async function latestTag(base: string): Promise<Result<string, string>> {
  const url = `${base}/latest`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  if (parsed.protocol === "file:") {
    try {
      const text = await readFile(fileURLToPath(parsed), "utf8");
      return { ok: true, value: text.trim() };
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
  }
  const response = await get(url);
  if (!response.ok) {
    return response;
  }
  const tag = tagFromUrl(response.value.url);
  if (tag === undefined) {
    return {
      ok: false,
      error: `latest did not redirect to a release tag: ${response.value.url}`,
    };
  }
  return { ok: true, value: tag };
}

/**
 * The bytes of one release asset, `<base>/download/<tag>/<name>`. Over
 * `file://` it is read from disk; over http(s) the answer's body is read
 * under the adapter's time limit. A non-2xx answer is an error.
 */
export async function download(
  base: string,
  tag: string,
  name: string,
): Promise<Result<Uint8Array, string>> {
  const url = `${base}/download/${tag}/${name}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  if (parsed.protocol === "file:") {
    try {
      return { ok: true, value: new Uint8Array(await readFile(parsed)) };
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `unsupported release URL: ${url}` };
  }
  const response = await get(url);
  if (!response.ok) {
    return response;
  }
  try {
    return {
      ok: true,
      value: new Uint8Array(await response.value.arrayBuffer()),
    };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}
