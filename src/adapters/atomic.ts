import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { restrictToCurrentUser } from "./acl.ts";

/** The mode whose Windows write needs an ACL that keeps the file to its owner. */
const PRIVATE_MODE = 0o600;

/** The error codes that mean the temp file isn't there anymore. */
const MISSING_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];

/** The fs code behind a caught error, if it carries one. */
function errorCode(error: unknown): string | undefined {
  const code: unknown =
    error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * A write refused because its target is a symlink: a state or repo path is
 * written in place, never through a link (contract "Where records are kept").
 */
export class SymlinkRefusal extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`ERROR: ${path} is a symlink.`);
    this.name = "SymlinkRefusal";
    this.path = path;
  }
}

/** The file operations a write runs, so a test can stand in for the rename. */
export interface AtomicWriteDeps {
  readonly rename: (from: string, to: string) => void;
}

const DEFAULT_DEPS: AtomicWriteDeps = { rename: renameSync };

/** The temp file a write goes to before the rename: a dot file in the same
 * folder, named for the process, so two runs never share one. */
function tempPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
}

/** Remove a temp file this write made; a file already gone is fine. */
function removeTemp(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!MISSING_CODES.includes(errorCode(error) ?? "")) {
      throw error;
    }
  }
}

/** Rethrow a failed write with the original as its cause, keeping the fs code
 * callers read to name the contract's reason. */
function rethrowWithCause(error: unknown): never {
  if (!(error instanceof Error)) {
    throw new Error(String(error), { cause: error });
  }
  const wrapped = new Error(error.message, { cause: error });
  const code = errorCode(error);
  if (code !== undefined) {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  throw wrapped;
}

/**
 * Write `text` to `path` atomically: the bytes go to a temp file in the same
 * folder, opened with `mode` and made exactly that mode despite the umask, are
 * fsynced, and are renamed over `path`. A symlink at `path` is refused with
 * `SymlinkRefusal` before anything is written (contract "Where records are
 * kept"). On Windows a 0600 write restricts the temp file to the current user
 * before its bytes go in, so no readable copy ever holds them. A failure after
 * the temp exists removes it and rethrows.
 */
export function writeAtomic(
  path: string,
  text: string | Uint8Array,
  mode: number,
  deps: AtomicWriteDeps = DEFAULT_DEPS,
): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() === true) {
    throw new SymlinkRefusal(path);
  }
  const temp = tempPath(path);
  let handle: number | undefined;
  let created = false;
  try {
    handle = openSync(temp, "wx", mode);
    created = true;
    chmodSync(temp, mode);
    if (process.platform === "win32" && mode === PRIVATE_MODE) {
      restrictToCurrentUser(temp);
    }
    writeFileSync(handle, text);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    deps.rename(temp, path);
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // The handle is gone either way; the write's own failure is the line
        // the contract reports.
      }
    }
    if (created) {
      try {
        removeTemp(temp);
      } catch (cleanup) {
        throw new Error(
          cleanup instanceof Error ? cleanup.message : String(cleanup),
          { cause: error },
        );
      }
    }
    rethrowWithCause(error);
  }
}
