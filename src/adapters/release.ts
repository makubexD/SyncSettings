/**
 * The release adapter: where the latest release tag lives and how to download
 * one of its assets. One base URL (`MKSYNC_RELEASE_URL`, a GitHub release page
 * by default) serves both a real release over http(s) and a test folder over
 * `file://`, so a test never reaches the network. When the environment names
 * no base and `gh` is signed in, the tag and the asset come from
 * `gh release view` / `gh release download` instead, so a private repo works;
 * a configured base always keeps the plain download path.
 *
 * Failure is a result, never an exception: a broken link, a non-2xx answer and
 * a missing file are errors the contract can print.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "../core/config/types.ts";
import { runGh } from "./gh.ts";
import type { GhResult } from "./gh.ts";

/** The repository the release comes from; `gh` names it with `--repo`. */
const RELEASE_REPO = "makubexD/SyncSettings";

/** Where a released program is downloaded from when the environment names no
 * other base. */
const DEFAULT_RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases`;

/** How long the lookup and each download may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 30_000;

/** How long one `gh` call may take before it is killed, as `gh.ts` gives
 * `gh pr create`. */
const GH_TIMEOUT_MS = 60_000;

/** The code `runGh` reports when `gh` never started or outlasted its limit. */
const GH_DID_NOT_RUN = -1;

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

/** Whether the environment names no release base, so the release lives at the
 * default GitHub URL and a signed-in `gh` may serve it. */
function hasDefaultBase(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const configured = env.MKSYNC_RELEASE_URL;
  return configured === undefined || configured === "";
}

/**
 * Whether the release should come through `gh`: only when the environment
 * names no release base and `gh auth status` succeeds. A configured base (for
 * example `file://`) is always the plain download path and never runs `gh`.
 */
export async function useGh(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (!hasDefaultBase(env)) {
    return false;
  }
  const status = await runGh(process.cwd(), ["auth", "status"], GH_TIMEOUT_MS);
  return status.ok;
}

/** The first non-empty line of a `gh` run's stderr, without its line ending. */
function firstStderrLine(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
}

/** The reason a failed `gh` run reports: its first stderr line, or a short
 * phrase when it never started or outlasted its limit. */
function ghError(result: GhResult): string {
  const line = firstStderrLine(result.stderr);
  if (line !== undefined) {
    return line;
  }
  return result.code === GH_DID_NOT_RUN
    ? "gh timed out or is missing"
    : `gh failed (exit ${result.code})`;
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

/** The latest release tag from `gh release view`, trimmed to the tag alone. */
async function latestTagViaGh(): Promise<Result<string, string>> {
  const result = await runGh(
    process.cwd(),
    [
      "release",
      "view",
      "--repo",
      RELEASE_REPO,
      "--json",
      "tagName",
      "-q",
      ".tagName",
    ],
    GH_TIMEOUT_MS,
  );
  if (!result.ok) {
    return { ok: false, error: ghError(result) };
  }
  const tag = result.stdout.trim();
  if (tag === "") {
    return { ok: false, error: "gh release view printed no tag" };
  }
  return { ok: true, value: tag };
}

/**
 * The latest release tag. When `gh` is signed in and no release base is
 * configured, `gh release view` answers; otherwise over `file://` a `latest`
 * file next to the release folder holds it, and over http(s) the
 * `<base>/latest` redirect is followed and the tag is read from the `/tag/`
 * URL it lands on.
 */
export async function latestTag(
  base: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Result<string, string>> {
  if (await useGh(env)) {
    return await latestTagViaGh();
  }
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

/** The bytes of one release asset from `gh release download`, read from the
 * temporary folder gh wrote it to and removed afterwards. */
async function downloadViaGh(
  tag: string,
  name: string,
): Promise<Result<Uint8Array, string>> {
  let folder: string;
  try {
    folder = await mkdtemp(join(tmpdir(), "mksync-release-"));
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  try {
    const result = await runGh(
      process.cwd(),
      [
        "release",
        "download",
        tag,
        "--repo",
        RELEASE_REPO,
        "-p",
        name,
        "-D",
        folder,
        "--clobber",
      ],
      GH_TIMEOUT_MS,
    );
    if (!result.ok) {
      return { ok: false, error: ghError(result) };
    }
    return {
      ok: true,
      value: new Uint8Array(await readFile(join(folder, name))),
    };
  } catch (error) {
    return { ok: false, error: reason(error) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The bytes of one release asset, `<base>/download/<tag>/<name>`. When `gh` is
 * signed in and no release base is configured, `gh release download` answers;
 * otherwise over `file://` it is read from disk, and over http(s) the answer's
 * body is read under the adapter's time limit. A non-2xx answer is an error.
 */
export async function download(
  base: string,
  tag: string,
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Result<Uint8Array, string>> {
  if (await useGh(env)) {
    return await downloadViaGh(tag, name);
  }
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
