/**
 * The dconf adapter: `dconf dump`, `dconf load` and the login home lookup
 * (`getent passwd`), run with an argument array and no shell. A missing tool, a
 * non-zero exit and a spawn error are typed results, never exceptions.
 *
 * The contract (`docs/sync-contract.md`, "dconf entries") prints these as
 * `dconf not installed`, `dconf dump failed` and `dconf load failed`.
 */

/** The mode a dconf entry needs for its command: `dump` reads, `load` writes. */
const DUMP_COMMAND = "dump";

const LOAD_COMMAND = "load";

/** The passwd database `getent` looks the login home up in. */
const PASSWD_DATABASE = "passwd";

/** The passwd line's sixth field, after user, password, uid, gid and gecos. */
const HOME_FIELD = 5;

/** A command that is not on `PATH`; Bun reports it as this spawn error. */
const NOT_FOUND = "ENOENT";

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

/** The `code` of a Bun spawn error, when it has one. */
function spawnErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code: unknown = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

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
  try {
    const child = Bun.spawn([command, ...args], {
      env: { ...env },
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain stderr as well, so a chatty tool cannot block on a full pipe.
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return code === 0 ? { kind: "ok", text: stdout } : { kind: "failed" };
  } catch (error) {
    return spawnErrorCode(error) === NOT_FOUND
      ? { kind: "missing" }
      : { kind: "failed" };
  }
}

/**
 * `dconf dump <path>`: the folder's keys and values, byte for byte as dconf
 * prints them. No `dconf` on `PATH` is `missing` (`dconf not installed`); a
 * non-zero exit or a spawn error is `failed` (`dconf dump failed`).
 */
export async function dconfDump(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DumpResult> {
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
 * exit or a spawn error is `failed` (`dconf load failed`). Synchronous, because
 * the plan executor that runs it is.
 */
export function dconfLoad(
  path: string,
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): LoadResult {
  try {
    const result = Bun.spawnSync({
      cmd: ["dconf", LOAD_COMMAND, path],
      env: { ...env },
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0 ? { kind: "ok" } : { kind: "failed" };
  } catch (error) {
    return spawnErrorCode(error) === NOT_FOUND
      ? { kind: "missing" }
      : { kind: "failed" };
  }
}

/**
 * The home field of `getent passwd <user>`'s first line. The import's
 * login-home guard compares `HOME` with it; a missing `getent`, a non-zero
 * exit and a malformed line all give `undefined`, so the guard leaves dconf
 * alone.
 */
export async function loginHome(
  user: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const result = await runTool("getent", [PASSWD_DATABASE, user], env);
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
