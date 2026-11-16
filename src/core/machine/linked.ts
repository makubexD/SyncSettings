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

const LINKED_DESTINATION_PREFIX = "linked: ";

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
    if (entry.merge !== "dir" || entry.localPath === undefined || entry.localPath === "") {
      return false;
    }
    const local = slashNormalized(entry.localPath);
    return normalizedFolder === local || normalizedFolder.startsWith(`${local}/`);
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
 * `MAX_LINKED_BYTES` bytes.
 */
export function suggestLinked(
  count: number,
  bytes: number,
  underHome: boolean,
): LinkedSuggestion {
  const small = count < MAX_LINKED_FILES && bytes < MAX_LINKED_BYTES;
  return underHome && small ? "profile" : "no";
}
