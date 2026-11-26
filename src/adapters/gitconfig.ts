/**
 * Git's own view of its global config, for `mksync doctor` (contract "Front
 * door"): the XDG file, the include paths and `~/.gitconfig.local`. Reads
 * only; a git that fails or is missing reads as no includes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { decode, run } from "./process.ts";

/** What one `git config --global` call returned. */
export interface GitConfigResult {
  readonly code: number;
  readonly stdout: string;
}

/** Runs `git` with these arguments; injected so the tests need no real git. */
export type GitConfigRunner = (
  args: readonly string[],
) => Promise<GitConfigResult>;

/** What the adapter found. */
export interface GitConfigFacts {
  readonly xdgConfig: boolean;
  /** Every include value, the home folder written as `~`, in git's order. */
  readonly includes: readonly string[];
  readonly localExists: boolean;
}

/** `-z` ends each value with NUL, so a path with a newline or space stays whole. */
const INCLUDE_ARGS = [
  "config",
  "--global",
  "-z",
  "--get-all",
  "include.path",
] as const;

const INCLUDE_IF_ARGS = [
  "config",
  "--global",
  "-z",
  "--get-regexp",
  "^includeif\\..*\\.path$",
] as const;

const XDG_PARTS = [".config", "git", "config"] as const;

const LOCAL_FILE = ".gitconfig.local";

const HOME_MARK = "~";

/** The real runner: `git` with no shell, its stdout decoded. */
export async function runGitConfig(
  args: readonly string[],
): Promise<GitConfigResult> {
  const result = await run(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return { code: result.code, stdout: decode(result.stdout) };
}

/** The NUL-ended records of a `-z` run; exit 1 (no match) or any failure is none. */
function records(result: GitConfigResult): string[] {
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.split("\0").filter((record) => record !== "");
}

/** `--get-regexp -z` prints `key\nvalue`; a key with no value has no path. */
function regexpValue(record: string): string | undefined {
  const newline = record.indexOf("\n");
  return newline === -1 ? undefined : record.slice(newline + 1);
}

/** `path` with the home folder written as `~`, either separator after it. */
export function tildePath(path: string, home: string): string {
  const homes = new Set([home, home.replaceAll("\\", "/")]);
  for (const prefix of homes) {
    if (path === prefix) {
      return HOME_MARK;
    }
    const rest = path.slice(prefix.length);
    if (path.startsWith(prefix) && (rest[0] === "/" || rest[0] === "\\")) {
      // One separator after `~`, so a Windows include matches the synced set.
      return `${HOME_MARK}${rest.replaceAll("\\", "/")}`;
    }
  }
  return path;
}

/** Read git's view of its global config under `home`. */
export async function readGitFacts(
  home: string,
  git: GitConfigRunner = runGitConfig,
  exists: (path: string) => boolean = existsSync,
): Promise<GitConfigFacts> {
  const [plain, conditional] = await Promise.all([
    git(INCLUDE_ARGS),
    git(INCLUDE_IF_ARGS),
  ]);
  const values = [
    ...records(plain),
    ...records(conditional).flatMap((record) => {
      const value = regexpValue(record);
      return value === undefined ? [] : [value];
    }),
  ];
  return {
    xdgConfig: exists(join(home, ...XDG_PARTS)),
    includes: values.map((value) => tildePath(value, home)),
    localExists: exists(join(home, LOCAL_FILE)),
  };
}
