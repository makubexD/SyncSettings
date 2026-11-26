/**
 * Linked folders: the folders a synced file points at, which the program
 * offers as `dir` entries (contract "Linked folders"). The core does no I/O;
 * callers pass an existence predicate.
 */

/** The shape `unaskedFolders` needs from a config entry. */
export interface LinkedEntry {
  readonly merge: string;
  readonly localPath?: string;
}

/** "profile" means "add a `dir` entry to this profile"; "no" means "ask no
 * more about it". */
export type LinkedSuggestion = "profile" | "no";

/** A suggestion needs fewer files and bytes than these limits. */
export const MAX_LINKED_FILES = 1000;
export const MAX_LINKED_BYTES = 10 * 1024 * 1024;

/** The `destinations` key prefix a linked folder's answer is stored under;
 * contract "Linked folders". */
export const LINKED_DESTINATION_PREFIX = "linked: ";

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

const TRAILING_SEPARATORS = /[\\/]+$/;

/** The same patterns `Find-LinkedPaths` reads in `scripts/windows/`: an
 * MSYS-style drive folder (`/c/Tools`) and a Windows one (`C:\Tools`). */
const UNIX_DRIVE_PATTERN = /\/([a-zA-Z])\/([\w./-]+)/g;
const WINDOWS_DRIVE_PATTERN = /([A-Z]):\\([\w.\\-]+)/g;

/** Home-relative references: `~/`, `$HOME/` and `%USERPROFILE%\`. */
const TILDE_PATTERN = /~([\\/])([\w.\\/-]+)/g;
const HOME_VARIABLE_PATTERN = /\$HOME([\\/])([\w.\\/-]+)/g;
const USERPROFILE_PATTERN = /%USERPROFILE%([\\/])([\w.\\/-]+)/g;

interface Candidate {
  readonly index: number;
  readonly path: string;
}

function withoutTrailingSeparators(path: string): string {
  return path.replace(TRAILING_SEPARATORS, "");
}

function slashNormalized(path: string): string {
  return withoutTrailingSeparators(path.replaceAll("\\", "/"));
}

/** `Find-LinkedPaths` strips a glob suffix such as `/*.bat` and any trailing
 * slash from its MSYS matches. */
function cleanUnixDrive(path: string): string {
  return withoutTrailingSeparators(path.replace(/\/\*\.[^/]*$/, ""));
}

function expandHomeReference(
  home: string,
  separator: string | undefined,
  tail: string | undefined,
): string {
  const base = withoutTrailingSeparators(home);
  const rest = withoutTrailingSeparators(tail ?? "");
  if (rest === "") {
    return base;
  }
  return `${base}${separator ?? "/"}${rest}`;
}

function collect(
  pattern: RegExp,
  text: string,
  toPath: (match: RegExpExecArray) => string,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const match of text.matchAll(pattern)) {
    candidates.push({ index: match.index, path: toPath(match) });
  }
  return candidates;
}

/**
 * The folder paths `text` references, in first-seen order with duplicates
 * removed. `~`, `$HOME` and `%USERPROFILE%` are expanded against `home`.
 */
export function linkedFolders(text: string, home: string): readonly string[] {
  const candidates: Candidate[] = [
    ...collect(UNIX_DRIVE_PATTERN, text, (match) => cleanUnixDrive(match[0])),
    ...collect(WINDOWS_DRIVE_PATTERN, text, (match) =>
      withoutTrailingSeparators(match[0]),
    ),
    ...collect(TILDE_PATTERN, text, (match) =>
      expandHomeReference(home, match[1], match[2]),
    ),
    ...collect(HOME_VARIABLE_PATTERN, text, (match) =>
      expandHomeReference(home, match[1], match[2]),
    ),
    ...collect(USERPROFILE_PATTERN, text, (match) =>
      expandHomeReference(home, match[1], match[2]),
    ),
  ];
  candidates.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const folders: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) {
      continue;
    }
    seen.add(candidate.path);
    folders.push(candidate.path);
  }
  return folders;
}

/** A `dir` entry syncs `folder` when its local path is the folder or one of
 * its ancestors. Local paths are compared with one separator style. */
function syncedByEntry(
  folder: string,
  entries: readonly LinkedEntry[],
): boolean {
  const normalizedFolder = slashNormalized(folder);
  return entries.some((entry) => {
    if (
      entry.merge !== "dir" ||
      entry.localPath === undefined ||
      entry.localPath === ""
    ) {
      return false;
    }
    const local = slashNormalized(entry.localPath);
    return (
      normalizedFolder === local || normalizedFolder.startsWith(`${local}/`)
    );
  });
}

/**
 * The folders worth asking about: they exist, no `dir` entry syncs them and
 * the profile hasn't answered `linked: <folder>`.
 */
export function unaskedFolders(
  found: readonly string[],
  entries: readonly LinkedEntry[],
  destinations: Readonly<Record<string, string>>,
  exists: (path: string) => boolean,
): readonly string[] {
  return found.filter(
    (folder) =>
      exists(folder) &&
      !syncedByEntry(folder, entries) &&
      !Object.hasOwn(destinations, `${LINKED_DESTINATION_PREFIX}${folder}`),
  );
}

/**
 * Whether a linked folder should be suggested as a profile `dir` entry: only
 * under the home, with fewer than `MAX_LINKED_FILES` files and fewer than
 * `MAX_LINKED_BYTES` bytes, and with a `name` that doesn't start with `.`: a
 * hidden folder (`.nvm`, `.cargo`) is a tool's own install, not settings.
 */
export function suggestLinked(
  count: number,
  bytes: number,
  underHome: boolean,
  name: string,
): LinkedSuggestion {
  const small = count < MAX_LINKED_FILES && bytes < MAX_LINKED_BYTES;
  const hidden = name.startsWith(".");
  return underHome && small && !hidden ? "profile" : "no";
}

/**
 * The form a linked folder is shown and stored in: `~` for the home itself,
 * `~/<rest>` under it (either separator, always `/` in the result), and the
 * path unchanged otherwise. No home path reaches a state file.
 */
export function homeForm(path: string, home: string): string {
  if (home === "") {
    return path;
  }
  const base = withoutTrailingSeparators(home.replaceAll("\\", "/"));
  const normalized = withoutTrailingSeparators(path.replaceAll("\\", "/"));
  if (normalized === base) {
    return "~";
  }
  if (normalized.startsWith(`${base}/`)) {
    return `~/${normalized.slice(base.length + 1)}`;
  }
  return path;
}

/** A linked folder's size in the question's words: bytes, then KB, then MB,
 * rounded to the nearest whole unit. */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) {
    return `${bytes} B`;
  }
  if (bytes < BYTES_PER_MB) {
    return `${Math.round(bytes / BYTES_PER_KB)} KB`;
  }
  return `${Math.round(bytes / BYTES_PER_MB)} MB`;
}

/** The number a suggestion answers with: `1) this profile` or `3) no`. */
export function linkedSuggestionNumber(suggestion: LinkedSuggestion): 1 | 3 {
  return suggestion === "profile" ? 1 : 3;
}

/** The contract's question for one linked folder; the asker adds the
 * suggested answer after it. */
export function linkedQuestion(
  file: string,
  path: string,
  count: number,
  bytes: number,
): string {
  const files = count === 1 ? "1 file" : `${count} files`;
  return (
    `${file} uses ${path} (${files}, ${formatSize(bytes)}). ` +
    `Sync it as a folder? 1) this profile  2) this machine  3) no`
  );
}

/** The contract's status line for a linked folder setup hasn't asked about. */
export function linkedStatusLine(path: string): string {
  return `Linked folder not synced: ${path} (mksync setup asks)`;
}
