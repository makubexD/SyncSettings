import { spawnSync } from "node:child_process";

/** A Windows security identifier; never a name, so no domain lookup happens. */
const SID_PATTERN = /^S-1-[0-9-]+$/;

/** A private file drops every inherited grant and grants its owner only. */
const NO_INHERITANCE = "/inheritance:r";

const REPLACE_GRANT = "/grant:r";

const FULL_CONTROL = ":F";

/**
 * The `icacls` arguments that make `path` readable by the owner `sid` only:
 * inherited access is removed and existing grants are replaced, not added to.
 */
export function icaclsArgs(path: string, sid: string): readonly string[] {
  if (!SID_PATTERN.test(sid)) {
    throw new RangeError(`not a security identifier: ${sid}`);
  }
  return [path, NO_INHERITANCE, REPLACE_GRANT, `*${sid}${FULL_CONTROL}`];
}

/** The SID from `whoami /user /fo csv /nh`, or undefined when it prints none. */
export function parseWhoamiSid(stdout: string): string | undefined {
  const fields = [...stdout.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  const last = fields.at(-1);
  return last !== undefined && SID_PATTERN.test(last) ? last : undefined;
}

function runChecked(file: string, args: readonly string[]): string {
  const result = spawnSync(file, args, { encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`${file} could not run`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${file} exited with status ${String(result.status)}`);
  }
  return result.stdout;
}

/**
 * Make `path` readable by the current user only, by SID. POSIX modes are set by
 * the caller, so this does nothing outside Windows.
 */
export function restrictToCurrentUser(path: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const sid = parseWhoamiSid(
    runChecked("whoami", ["/user", "/fo", "csv", "/nh"]),
  );
  if (sid === undefined) {
    throw new Error("whoami printed no security identifier");
  }
  runChecked("icacls", icaclsArgs(path, sid));
}
