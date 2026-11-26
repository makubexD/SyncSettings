import type { Os } from "../config/types.ts";
import type { Values } from "../values/sanitize.ts";

/** `commit.sh`'s machine alias: lowercase letters, digits and `-`, at most 24
 * characters and no leading `-` (`resolve_machine_alias`). */
export const MACHINE_ALIAS = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** Past this many characters `commit.sh` shortens the default message. */
const MESSAGE_LIMIT = 72;

/** The default message when no status line classifies (`build_commit_message`)
 * in `commit.sh`. */
const DEFAULT_MESSAGE = "sync: update config files";

/** The sync paths `commit.sh` owns; `packages/` is optional. */
const DOTFILES_ROOT = "dotfiles";

const CONFIG_FILE = "sync-config.json";

const PACKAGES_ROOT = "packages";

const BACKSLASH = "\\";

const QUOTE = '"';

const RENAME_ARROW = " -> ";

/**
 * The branch `commit.sh` creates: `sync/<os>-<machine>-<stamp>`, never
 * `master` (contract "Checks before pushing", The PR). `machine` is the alias
 * the script requires: lowercase letters, digits and `-` only, at most 24
 * characters and not starting with `-`; anything else is refused, as the
 * script's `resolve_machine_alias` does rather than rewriting it. `stamp` is
 * already formatted (`date +%Y%m%d-%H%M`).
 */
export function branchName(os: Os, machine: string, stamp: string): string {
  if (!MACHINE_ALIAS.test(machine)) {
    throw new RangeError(
      `invalid machine alias '${machine}' (use a-z, 0-9, -)`,
    );
  }
  return `sync/${os}-${machine}-${stamp}`;
}

/** The longest public name the suggestion may produce (decision 1). */
const ALIAS_LIMIT = 24;

/** The error `push` prints for a name that is not a valid alias. */
function invalidAliasError(answer: string): string {
  return `ERROR: invalid machine alias '${answer}' (use a-z, 0-9, -).`;
}

/** The hostname's short form: its text up to the first dot. */
function shortHostname(hostname: string): string {
  const dot = hostname.indexOf(".");
  return dot === -1 ? hostname : hostname.slice(0, dot);
}

/**
 * The public name `push` suggests for a machine, from its login (decision 1):
 * the text after the last `\` of a `DOMAIN\login` form, lowercased, each run
 * of characters outside `a-z0-9` replaced by one `-`, `-` trimmed from both
 * ends and the result cut to 24 characters with any trailing `-` trimmed
 * again. `undefined` when nothing is left or the result is the hostname or
 * its short form, ignoring case.
 */
export function suggestAlias(
  login: string,
  hostname: string,
): string | undefined {
  const bare = login.slice(login.lastIndexOf(BACKSLASH) + 1);
  const dashed = bare.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  const alias = trimmed.slice(0, ALIAS_LIMIT).replace(/-+$/, "");
  if (alias === "") {
    return undefined;
  }
  const hostnames = [
    hostname.toLowerCase(),
    shortHostname(hostname).toLowerCase(),
  ];
  if (hostnames.includes(alias)) {
    return undefined;
  }
  return alias;
}

/**
 * Whether an answer to the public-name prompt is usable (decision 2). The
 * hostname is refused first, then the machine alias rule; the error lines are
 * the ones `push` prints, and the hostname check is case-insensitive for both
 * the full hostname and its short form.
 */
export function checkAlias(
  answer: string,
  record: { readonly hostname: string },
): { readonly alias: string } | { readonly error: string } {
  const folded = answer.toLowerCase();
  const hostnames = [
    record.hostname.toLowerCase(),
    shortHostname(record.hostname).toLowerCase(),
  ];
  if (hostnames.includes(folded)) {
    return {
      error: `ERROR: '${answer}' is this machine's hostname; pick another public name.`,
    };
  }
  if (!MACHINE_ALIAS.test(answer)) {
    return { error: invalidAliasError(answer) };
  }
  return { alias: answer };
}

/** The name a status line changes: everything after its last `/`. */
function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/**
 * `commit.sh`'s default message: the changed files' base names grouped as
 * `add`, `update` and `remove` (codes `A` and `??`, `M`, and `D`; other codes,
 * renames included, are left out), joined with `; ` after `sync: `. Nothing
 * classified is `sync: update config files`; over 72 characters it becomes
 * `sync: update <n> config file(s)`.
 */
function defaultCommitMessage(statusLines: readonly string[]): string {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const line of statusLines) {
    if (line.length < 4) {
      continue;
    }
    const code = line.slice(0, 2).trim();
    const name = baseName(line.slice(3).trim());
    if (code === "A" || code === "??") {
      added.push(name);
    } else if (code === "M") {
      modified.push(name);
    } else if (code === "D") {
      deleted.push(name);
    }
  }
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`add ${added.join(", ")}`);
  }
  if (modified.length > 0) {
    parts.push(`update ${modified.join(", ")}`);
  }
  if (deleted.length > 0) {
    parts.push(`remove ${deleted.join(", ")}`);
  }
  if (parts.length === 0) {
    return DEFAULT_MESSAGE;
  }
  const message = `sync: ${parts.join("; ")}`;
  if (message.length <= MESSAGE_LIMIT) {
    return message;
  }
  const total = added.length + modified.length + deleted.length;
  return `sync: update ${total} config file(s)`;
}

/**
 * The commit message `commit.sh` uses: the `-m` message when one is given,
 * else the default built from the status lines. The OS and machine are not
 * part of it; they name the branch and the PR body.
 */
export function commitMessage(
  message: string | undefined,
  statusLines: readonly string[],
): string {
  if (message === undefined || message === "") {
    return defaultCommitMessage(statusLines);
  }
  return message;
}

/**
 * The PR body `commit.sh` writes: a `## What changed` heading, each status
 * line as a list item, then `Platform: <os> · Machine: <machine>` and the
 * reminder to add the `reviewed` label. With a profile, a `Profile: <p>` line
 * follows the machine line, just before the closing blank line.
 */
export function prBody(
  statusLines: readonly string[],
  os: Os,
  machine: string,
  profile: string | undefined,
): string {
  const lines = [
    "## What changed",
    "",
    ...statusLines.map((line) => `- \`${line}\``),
    "",
    `Platform: ${os} · Machine: ${machine}`,
    ...(profile === undefined ? [] : [`Profile: ${profile}`]),
    "",
    "When the review is done, add the **`reviewed`** label.",
  ];
  return `${lines.join("\n")}\n`;
}

/** A path token of a status line: its value and the index just past it. */
interface PathToken {
  readonly path: string;
  readonly end: number;
}

/** Read a possibly quoted path starting at `start`, ending where `findEnd`
 * says (the arrow of a rename, or the end of the line). */
function readPath(
  text: string,
  start: number,
  findEnd: (from: number) => number,
): PathToken {
  if (text.charAt(start) === QUOTE) {
    let index = start + 1;
    while (index < text.length) {
      const char = text.charAt(index);
      if (char === BACKSLASH) {
        index += 2;
        continue;
      }
      if (char === QUOTE) {
        break;
      }
      index += 1;
    }
    const end = Math.min(index + 1, text.length);
    return { path: unquote(text.slice(start, end)), end };
  }
  const end = findEnd(start);
  return { path: text.slice(start, end), end };
}

/**
 * The text of a quoted path without its quotes, git's C-style `quote_path`
 * escapes read back: `\a \b \f \n \r \t \v \\ \"` and three-digit octal bytes
 * (a non-ASCII character arrives as its UTF-8 bytes in octal). A token with no
 * surrounding quotes is returned as it is.
 */
function unquote(text: string): string {
  if (text.length < 2 || !text.startsWith(QUOTE) || !text.endsWith(QUOTE)) {
    return text;
  }
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let index = 0;
  while (index < body.length) {
    const char = body.charAt(index);
    index += 1;
    if (char !== BACKSLASH) {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const escape = body.charAt(index);
    index += 1;
    switch (escape) {
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case BACKSLASH:
        bytes.push(0x5c);
        break;
      case QUOTE:
        bytes.push(0x22);
        break;
      default: {
        if (escape >= "0" && escape <= "7") {
          let octal = escape;
          while (octal.length < 3 && index < body.length) {
            const digit = body.charAt(index);
            if (digit < "0" || digit > "7") {
              break;
            }
            octal += digit;
            index += 1;
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff);
        } else {
          bytes.push(...encoder.encode(escape));
        }
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The old and new paths of a rename or copy line, else its one path.
 * shortcut: an unquoted path may itself hold ` -> `; the first occurrence
 * splits, and git quotes a path only for control characters, quotes,
 * backslashes and non-ASCII, so such a path is read wrong. */
function statusPaths(line: string): readonly string[] {
  if (line.length < 4) {
    return [];
  }
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  if (!code.includes("R") && !code.includes("C")) {
    return [unquote(rest)];
  }
  const arrowAt = (from: number): number => {
    const arrow = rest.indexOf(RENAME_ARROW, from);
    return arrow === -1 ? rest.length : arrow;
  };
  const old = readPath(rest, 0, arrowAt);
  const tail = rest.slice(old.end);
  if (!tail.startsWith(RENAME_ARROW)) {
    return [old.path];
  }
  const newPath = readPath(
    rest,
    old.end + RENAME_ARROW.length,
    () => rest.length,
  );
  return [old.path, newPath.path];
}

/** Whether a status path is one `commit.sh` owns: under `dotfiles/`, the
 * config file itself, or under `packages/` when that folder exists. */
function isSyncPath(path: string, hasPackages: boolean): boolean {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === DOTFILES_ROOT || trimmed.startsWith(`${DOTFILES_ROOT}/`)) {
    return true;
  }
  if (trimmed === CONFIG_FILE) {
    return true;
  }
  return (
    hasPackages &&
    (trimmed === PACKAGES_ROOT || trimmed.startsWith(`${PACKAGES_ROOT}/`))
  );
}

/**
 * Contract "Checks before pushing", Changes outside the sync paths: the
 * `git status --porcelain` lines that name a path outside `dotfiles/`,
 * `sync-config.json` and `packages/` (the last only when the folder exists).
 * A rename counts as outside when either side is. Lines come back as git
 * printed them, in order.
 */
export function outsidePaths(
  porcelain: string,
  hasPackages: boolean,
): readonly string[] {
  const outside: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      continue;
    }
    const paths = statusPaths(line);
    // A line too short to hold a path is refused rather than let through.
    const isOutside = paths.some((path) => !isSyncPath(path, hasPackages));
    if (paths.length === 0 || isOutside) {
      outside.push(line);
    }
  }
  return outside;
}

/** A changed sync file's text, or the bytes an adapter read. */
export type SyncFileContent = string | Uint8Array;

/** One cached value found in a changed sync file: the placeholder it belongs
 * to and the file, never the value. */
export interface CachedValueHit {
  readonly placeholder: string;
  readonly file: string;
}

function textOf(content: SyncFileContent): string {
  return typeof content === "string"
    ? content
    : new TextDecoder().decode(content);
}

/**
 * Contract "Checks before pushing", Cached values: the changed sync files that
 * hold a `.user-values.json` value, ignoring case and also matching the
 * backslash-doubled form. Empty values are skipped, and a value equal to its
 * own placeholder is skipped, so a placeholder on its own passes. Placeholders
 * are visited sorted; for each, every matching file is listed once in `files`
 * order, as `grep -l` does. `commit.sh` prints the first pair; the value never
 * leaves this function.
 */
export function cachedValueHits(
  files: ReadonlyMap<string, SyncFileContent>,
  values: Values,
): readonly CachedValueHit[] {
  const hits: CachedValueHit[] = [];
  for (const placeholder of Object.keys(values).sort()) {
    const value = values[placeholder];
    if (value === undefined || value === "" || value === placeholder) {
      continue;
    }
    const forms = [value];
    if (value.includes(BACKSLASH)) {
      forms.push(value.replaceAll(BACKSLASH, `${BACKSLASH}${BACKSLASH}`));
    }
    const folded = forms.map((form) => form.toLowerCase());
    for (const [file, content] of files) {
      const text = textOf(content).toLowerCase();
      if (folded.some((form) => text.includes(form))) {
        hits.push({ placeholder, file });
      }
    }
  }
  return hits;
}
