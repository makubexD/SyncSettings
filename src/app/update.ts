/**
 * `mksync update` (contract "Update", decision 5): find the latest release,
 * download and check it, and replace the running program with it. The pure
 * decision (asset name, version order, checksum match) lives in
 * `core/update/update.ts`; this flow owns the I/O and the order of the checks.
 *
 * Every effect is a dependency, so the flow is testable without the network,
 * a release or a real `gh`.
 */

import { createHash } from "node:crypto";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decode, run } from "../adapters/process.ts";
import { download, latestTag, releaseBase } from "../adapters/release.ts";
import {
  assetName,
  isNewer,
  parseSums,
  planUpdate,
} from "../core/update/update.ts";
import { failure } from "./export.ts";
import type { Result } from "./export.ts";

/** The file the program is written to before it replaces the running one. */
const NEW_SUFFIX = ".new";

/** The name a running Windows program is moved to before the replacement,
 * because the OS will not overwrite a file that is running. */
export const OLD_PROGRAM_NAME = "mksync.old.exe";

/** An installed program is executable by everyone, as `~/.local/bin/mksync`
 * is. */
const PROGRAM_MODE = 0o755;

/** The `SHA256SUMS` file every release carries. */
const SUMS_NAME = "SHA256SUMS";

/** The repository the release and its attestation come from. */
const RELEASE_REPO = "makubexD/SyncSettings";

/** How long one `gh` call may take before it is killed. */
const GH_TIMEOUT_MS = 60_000;

/** The refusal when the program runs from the clone: `git pull` updates that
 * copy, and downloading over it would fight the clone. */
const LAUNCHER_ERROR =
  "ERROR: mksync runs from the clone here; update it with git pull.";

/** The release has no asset for this platform and CPU. */
function noAssetError(platform: string, arch: string): string {
  return `ERROR: no mksync release for ${platform}-${arch}.`;
}

/** Every failed lookup or download prints the same line, with the reason the
 * adapter gave. */
function cannotGet(error: string): Result {
  return failure(`ERROR: cannot get the mksync release: ${error}.`, 1);
}

/** The release is no newer than the running program. */
function upToDate(current: string): Result {
  return { code: 0, stdout: `mksync ${current} is up to date.\n`, stderr: "" };
}

/** Delete a file that may not be there, for the leftover of an earlier
 * Windows update. */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

/** Whether a caught fs error means the file was not there to begin with. */
function isMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** The install folder refused the new program; the old one still runs. */
function cannotReplace(execPath: string, error: unknown): Result {
  const reason = error instanceof Error ? error.message : String(error);
  return failure(
    `ERROR: cannot replace ${execPath}: ${reason}; nothing changed.`,
    1,
  );
}

/**
 * Rename `newPath` over the running program, or `undefined` on success. On
 * Windows the running program moves to `mksync.old.exe` first and moves back
 * when the second rename fails, so a failure never leaves no program.
 */
function replaceProgram(
  newPath: string,
  execPath: string,
  platform: string,
): Result | undefined {
  const oldPath = join(dirname(execPath), OLD_PROGRAM_NAME);
  const isWindows = platform === "win32";
  try {
    if (isWindows) {
      removeIfPresent(oldPath);
      renameSync(execPath, oldPath);
    }
  } catch (error) {
    removeIfPresent(newPath);
    return cannotReplace(execPath, error);
  }
  try {
    renameSync(newPath, execPath);
  } catch (error) {
    if (isWindows) {
      renameSync(oldPath, execPath);
    }
    removeIfPresent(newPath);
    return cannotReplace(execPath, error);
  }
  return undefined;
}

/** What `mksync update` reads from the run: the running version and path, the
 * machine it runs on, the environment, and the attestation check. */
export interface UpdateDeps {
  /** The version the running program reports (`mksync --version`). */
  readonly current: string;
  /** The program's own path, which a successful update replaces. */
  readonly execPath: string;
  /** `process.platform`, so the release asset can be picked. */
  readonly platform: string;
  /** `process.arch`, so the release asset can be picked. */
  readonly arch: string;
  /** The environment `MKSYNC_RELEASE_URL` and `MKSYNC_LAUNCHER` are read
   * from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Check `file` against the release's provenance attestation: `skipped`
   * when `gh` is missing or signed out, `verified` on a passing check, and
   * `failed` when the check does not pass. */
  readonly verifyAttestation: (
    file: string,
  ) => Promise<"skipped" | "verified" | "failed">;
}

/**
 * The `gh` attestation check: `gh auth status` first, so a machine without a
 * signed-in `gh` skips the check instead of failing the update. Any non-zero
 * status there, including a missing `gh`, is `skipped`; a signed-in `gh` that
 * does not verify the file is `failed`.
 */
async function verifyWithGh(
  file: string,
): Promise<"skipped" | "verified" | "failed"> {
  const status = await run(["gh", "auth", "status"], {
    stdout: "ignore",
    stderr: "ignore",
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (status.code !== 0) {
    return "skipped";
  }
  const verify = await run(
    ["gh", "attestation", "verify", file, "--repo", RELEASE_REPO],
    { stdout: "ignore", stderr: "ignore", timeoutMs: GH_TIMEOUT_MS },
  );
  return verify.code === 0 ? "verified" : "failed";
}

/** The dependencies of a real run: the process facts and the `gh` check. */
export function defaultUpdateDeps(version: string): UpdateDeps {
  return {
    current: version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    verifyAttestation: verifyWithGh,
  };
}

/**
 * Fetch the latest release, check it against `SHA256SUMS` and, when it is
 * newer, write it beside the running program and rename it over. Nothing is
 * written before every check passes; a failure leaves the program as it was.
 */
export async function executeUpdate(deps: UpdateDeps): Promise<Result> {
  if (deps.env.MKSYNC_LAUNCHER === "1") {
    return failure(LAUNCHER_ERROR, 2);
  }
  const asset = assetName(deps.platform, deps.arch);
  if (asset === undefined) {
    return failure(noAssetError(deps.platform, deps.arch), 1);
  }
  const base = releaseBase(deps.env);
  const latest = await latestTag(base);
  if (!latest.ok) {
    return cannotGet(latest.error);
  }
  if (!isNewer(deps.current, latest.value)) {
    return upToDate(deps.current);
  }
  const sumsText = await download(base, latest.value, SUMS_NAME);
  if (!sumsText.ok) {
    return cannotGet(sumsText.error);
  }
  const sums = parseSums(decode(sumsText.value));
  if (!sums.ok) {
    return failure(`ERROR: SHA256SUMS: ${sums.error}.`, 1);
  }
  const program = await download(base, latest.value, asset);
  if (!program.ok) {
    return cannotGet(program.error);
  }
  const downloadedSha = createHash("sha256")
    .update(program.value)
    .digest("hex");
  const plan = planUpdate({
    current: deps.current,
    latestTag: latest.value,
    expectedSha: sums.value.get(asset) ?? "",
    downloadedSha,
  });
  if (plan.kind === "mismatch") {
    return failure(
      `ERROR: ${asset}: checksum does not match SHA256SUMS; nothing changed.`,
      1,
    );
  }
  if (plan.kind === "up-to-date") {
    return upToDate(deps.current);
  }
  const newPath = `${deps.execPath}${NEW_SUFFIX}`;
  try {
    writeFileSync(newPath, program.value);
    if (deps.platform !== "win32") {
      chmodSync(newPath, PROGRAM_MODE);
    }
  } catch (error) {
    removeIfPresent(newPath);
    return cannotReplace(deps.execPath, error);
  }
  if ((await deps.verifyAttestation(newPath)) === "failed") {
    unlinkSync(newPath);
    return failure(
      `ERROR: ${asset}: attestation check failed; nothing changed.`,
      1,
    );
  }
  const replaced = replaceProgram(newPath, deps.execPath, deps.platform);
  if (replaced !== undefined) {
    return replaced;
  }
  return {
    code: 0,
    stdout: `mksync updated: ${plan.from} -> ${plan.to}.\n`,
    stderr: "",
  };
}
