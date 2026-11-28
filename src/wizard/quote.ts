import type { Os } from "../core/config/types.ts";

/** A token made only of these needs no quotes (contract "mksync setup", `Same as:`). */
const PLAIN_TOKEN = /^[A-Za-z0-9._@/:+=-]*$/;

/** The characters PowerShell reads as a single quote: `'` and the typographic
 * U+2018 to U+201B. Each is escaped by doubling it. */
const POWERSHELL_QUOTE = /['\u2018-\u201b]/g;

/**
 * Quotes one `Same as:` token for the shell the line targets: left bare when
 * every character is in `A-Za-z0-9._@/:+=-`, else wrapped whole in single
 * quotes, with `'` written `'\''` on Linux and macOS (POSIX shells), and on
 * Windows (PowerShell) every single quote PowerShell reads, typographic ones
 * included, doubled. shortcut: an empty token stays bare, as the rule
 * reads; no current caller passes one.
 */
export function quoteToken(token: string, os: Os): string {
  if (PLAIN_TOKEN.test(token)) {
    return token;
  }
  const escaped =
    os === "windows"
      ? token.replace(POWERSHELL_QUOTE, "$&$&")
      : token.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}
