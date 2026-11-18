/**
 * The dconf adapter: `dconf dump`, `dconf load` and the login home lookup
 * (`getent passwd`), run with an argument array and no shell. A missing tool, a
 * non-zero exit and a spawn error are typed results, never exceptions.
 *
 * The contract (`docs/sync-contract.md`, "dconf entries") prints these as
 * `dconf not installed`, `dconf dump failed` and `dconf load failed`.
 */

import { isValidDconfPath } from "../core/config/dconf-path.ts";
import { decode, run, runSync } from "./process.ts";

/** The mode a dconf entry needs for its command: `dump` reads, `load` writes. */
const DUMP_COMMAND = "dump";

const LOAD_COMMAND = "load";

/** The passwd database `getent` looks the login home up in. */
const PASSWD_DATABASE = "passwd";

/** The passwd line's sixth field, after user, password, uid, gid and gecos. */
const HOME_FIELD = 5;

/** What `dconf dump` returned: the dump text, no `dconf`, or a failed dump. */
export type DumpResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/** What `dconf load` did: loaded, no `dconf`, or a failed load. */
export type LoadResult =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/** One tool run: its stdout when it exited 0, or why it did not succeed. */
type RunResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/**
 * Run `command` with an argument array and no shell, in the environment the
 * caller passes, so a test can point `PATH` at a temp folder. `input`, when
 * given, is fed to the process's stdin. A missing command is `missing`, a
 * non-zero exit or any other spawn error is `failed`.
 */
async function runTool(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  input?: string,
): Promise<RunResult> {
  const result = await run([command, ...args], {
    env: { ...env },
    stdout: "pipe",
    stderr: "pipe",
    ...(input === undefined ? {} : { input }),
  });
  if (result.missing === true) {
    return { kind: "missing" };
  }
  if (result.notStarted === true) {
    return { kind: "failed" };
  }
  return result.code === 0
    ? { kind: "ok", text: decode(result.stdout) }
    : { kind: "failed" };
}

/**
 * `dconf dump <path>`: the folder's keys and values, byte for byte as dconf
 * prints them. No `dconf` on `PATH` is `missing` (`dconf not installed`); a
 * non-zero exit or a spawn error is `failed` (`dconf dump failed`). A path that
 * is not a dconf folder is `failed` without running anything.
 */
export async function dconfDump(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DumpResult> {
  if (!isValidDconfPath(path)) {
    return { kind: "failed" };
  }
  const result = await runTool("dconf", [DUMP_COMMAND, path], env);
  switch (result.kind) {
    case "ok":
      return { kind: "ok", text: result.text };
    case "missing":
      return { kind: "missing" };
    case "failed":
      return { kind: "failed" };
  }
}

/**
 * `dconf load <path>` with `text` on stdin, merging the named keys into the
 * folder. No `dconf` on `PATH` is `missing` (`dconf not installed`); a non-zero
 * exit or a spawn error is `failed` (`dconf load failed`). A path that is not
 * a dconf folder is `failed` without running anything. Synchronous, because
 * the plan executor that runs it is.
 */
export function dconfLoad(
  path: string,
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): LoadResult {
  if (!isValidDconfPath(path)) {
    return { kind: "failed" };
  }
  const result = runSync(["dconf", LOAD_COMMAND, path], {
    env: { ...env },
    input: text,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.missing === true) {
    return { kind: "missing" };
  }
  if (result.notStarted === true) {
    return { kind: "failed" };
  }
  return result.code === 0 ? { kind: "ok" } : { kind: "failed" };
}

/**
 * The home field of `getent passwd <key>`'s first line. `key` is the passwd
 * database key: a login name or a numeric uid. The import's login-home guard
 * compares `HOME` with it; a missing `getent`, a non-zero exit and a malformed
 * line all give `undefined`, so the guard leaves dconf alone.
 */
export async function loginHome(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const result = await runTool("getent", [PASSWD_DATABASE, key], env);
  if (result.kind !== "ok") {
    return undefined;
  }
  const line = result.text.split("\n")[0];
  if (line === undefined) {
    return undefined;
  }
  const fields = line.split(":");
  const home = fields[HOME_FIELD];
  if (fields.length <= HOME_FIELD || home === undefined || home === "") {
    return undefined;
  }
  return home;
}
