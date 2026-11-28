import type { Os } from "../core/config/types.ts";

/** A token made only of these needs no quotes (contract "mksync setup", `Same as:`). */
const PLAIN_TOKEN = /^[A-Za-z0-9._@/:+=-]*$/;

/**
 * Quotes one `Same as:` token for the shell the line targets: left bare when
 * every character is in `A-Za-z0-9._@/:+=-`, else wrapped whole in single
 * quotes, with `'` written `'\''` on Linux and macOS (POSIX shells) and `''`
 * on Windows (PowerShell). shortcut: an empty token stays bare, as the rule
 * reads; no current caller passes one.
 */
export function quoteToken(token: string, os: Os): string {
  if (PLAIN_TOKEN.test(token)) {
    return token;
  }
  const escaped = token.replaceAll("'", os === "windows" ? "''" : "'\\''");
  return `'${escaped}'`;
}
