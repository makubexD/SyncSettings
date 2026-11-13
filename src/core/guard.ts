/**
 * The public-repo guard (contract "Public-repo guard (program only)"): which
 * local files a private repo would receive, and which tracked repo paths keep a
 * public repo from being pushed to. A pure decision: the adapters read the
 * visibility, the tracked paths and the local store.
 */

/** Whether the repo can receive profiles, machine records and values. */
export type Visibility = "public" | "private";

/** The layer folders of the state folder, which also name the repo roots a
 * private push writes them to (contract "Profile and machine, until phase 6"). */
export const PROFILES_FOLDER = "profiles";

export const MACHINES_FOLDER = "machines";

/** The repo path prefixes held until the repo is private. */
export const STATE_FOLDER_ROOTS: readonly string[] = [
  `${PROFILES_FOLDER}/`,
  `${MACHINES_FOLDER}/`,
];

/** The part of a local record or profile the guard reads: its file name. */
interface Named {
  readonly name: string;
}

/** What local state holds that a private repo would receive. */
export interface LocalRecords {
  readonly record?: Named;
  readonly profiles: readonly Named[];
}

/** The repo paths the guard holds and refuses. */
export interface GuardDecision {
  readonly held: readonly string[];
  readonly refused: readonly string[];
}

/**
 * An action's path is a state path when it names a profile or machine layer.
 * Compared case-insensitively: a case-insensitive filesystem (Windows, macOS)
 * treats `Profiles/` as `profiles/`, so the guard must too. The path itself is
 * kept as given, so what is reported keeps its original case.
 */
function isStatePath(path: string): boolean {
  const folded = path.toLowerCase();
  return STATE_FOLDER_ROOTS.some((root) => folded.startsWith(root));
}

function recordPath(name: string): string {
  return `${MACHINES_FOLDER}/${name}.json`;
}

function profilePath(name: string): string {
  return `${PROFILES_FOLDER}/${name}.json`;
}

/**
 * Contract "Public-repo guard (program only)": while public, `held` names the
 * local files a private push would add, sorted: `profiles/<name>.json` for
 * every local profile and `machines/<name>.json` for the local record.
 * `refused` names the tracked repo paths under those roots, compared
 * case-insensitively and reported as given, sorted. A private repo holds and
 * refuses nothing.
 */
export function guard(
  visibility: Visibility,
  repoPaths: readonly string[],
  localRecords: LocalRecords,
): GuardDecision {
  if (visibility === "private") {
    return { held: [], refused: [] };
  }
  const held = [
    ...localRecords.profiles.map((profile) => profilePath(profile.name)),
    ...(localRecords.record === undefined
      ? []
      : [recordPath(localRecords.record.name)]),
  ].sort();
  const refused = repoPaths.filter(isStatePath).sort();
  return { held, refused };
}
