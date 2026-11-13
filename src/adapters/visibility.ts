/**
 * Read whether the repo may receive profiles, machine records and values
 * (design "Public-repo guard"): a `github.com` origin is asked through `gh`,
 * then the public GitHub API, and every failure counts as public so the guard
 * fails closed. Any other origin follows `MKSYNC_VISIBILITY`, which is ignored
 * for `github.com` so it cannot switch the guard off on the real repo.
 */

/** Whether the repo can receive profiles, machine records and values. */
export type Visibility = "public" | "private";

/** What one command run returned: its exit code and raw stdout text. */
export interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
}

/** The part of a `fetch` reply the reader uses: its status and JSON body. */
export interface ApiReply {
  readonly status: number;
  json(): Promise<unknown>;
}

/** What the reader reaches outside itself: `gh` and the GitHub API. */
export interface VisibilityDeps {
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<CommandOutput>;
  readonly fetch: (url: string, signal: AbortSignal) => Promise<ApiReply>;
}

/** One parsed `github.com` origin: the repo the guard will ask about. */
interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
}

/** The origin forms that name a repo on `github.com`. */
const GITHUB_ORIGIN_PREFIXES = [
  "https://github.com/",
  "git@github.com:",
  "ssh://git@github.com/",
] as const;

/** `<owner>/<repo>`, with an optional `.git` suffix on the repo. */
const OWNER_REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/** Any origin naming the `github.com` host, parsed or not. */
const GITHUB_HOST = /(^|[@/.])github\.com([:/]|$)/i;

const GITHUB_API = "https://api.github.com/repos/";

/** How long the GitHub API answer may take before it counts as public. */
const API_TIMEOUT_MS = 5_000;

const OK = 200;

/** A command that could not start has no exit code; report it as -1. */
const FAILED_TO_START = -1;

/** The variable that decides visibility for origins other than `github.com`. */
const VISIBILITY_VARIABLE = "MKSYNC_VISIBILITY";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSON object, or `undefined` for anything else. */
function parseObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** Run one command with an argument array and no shell, as `git.ts` does. */
async function runCommand(
  command: string,
  args: readonly string[],
): Promise<CommandOutput> {
  try {
    const child = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    return { code, stdout };
  } catch {
    // A missing `gh` is reported as "gh cannot tell", so the API is asked.
    return { code: FAILED_TO_START, stdout: "" };
  }
}

const DEFAULT_DEPS: VisibilityDeps = {
  run: runCommand,
  fetch: async (url, signal) => await fetch(url, { signal }),
};

/**
 * The `owner/repo` a `github.com` origin names, or `undefined` when the origin
 * is not one of its HTTPS or SSH forms.
 */
function parseGitHubOrigin(origin: string): GitHubRepo | undefined {
  for (const prefix of GITHUB_ORIGIN_PREFIXES) {
    if (!origin.startsWith(prefix)) {
      continue;
    }
    const match = OWNER_REPO.exec(origin.slice(prefix.length));
    if (match === null) {
      continue;
    }
    const owner = match[1];
    const repo = match[2];
    if (owner === undefined || repo === undefined) {
      continue;
    }
    return { owner, repo };
  }
  return undefined;
}

/**
 * `gh repo view <owner>/<repo> --json visibility`, or `undefined` when `gh` is
 * missing, failing, not signed in, or answers anything but a visibility. An
 * `INTERNAL` repo is private: it is not public.
 */
async function readFromGh(
  repo: GitHubRepo,
  run: VisibilityDeps["run"],
): Promise<Visibility | undefined> {
  let output: CommandOutput;
  try {
    output = await run("gh", [
      "repo",
      "view",
      `${repo.owner}/${repo.repo}`,
      "--json",
      "visibility",
    ]);
  } catch {
    return undefined;
  }
  if (output.code !== 0) {
    return undefined;
  }
  const visibility = parseObject(output.stdout)?.visibility;
  if (typeof visibility !== "string") {
    return undefined;
  }
  switch (visibility.toUpperCase()) {
    case "PRIVATE":
    case "INTERNAL":
      return "private";
    case "PUBLIC":
      return "public";
    default:
      return undefined;
  }
}

/**
 * `GET /repos/<owner>/<repo>`: only a 200 with a boolean `private` answers;
 * every other status, network error, timeout or bad body counts as public.
 */
async function readFromApi(
  repo: GitHubRepo,
  fetchReply: VisibilityDeps["fetch"],
): Promise<Visibility> {
  try {
    const signal = AbortSignal.timeout(API_TIMEOUT_MS);
    const reply = await fetchReply(
      `${GITHUB_API}${repo.owner}/${repo.repo}`,
      signal,
    );
    if (reply.status !== OK) {
      return "public";
    }
    const body: unknown = await reply.json();
    return isRecord(body) && body.private === true ? "private" : "public";
  } catch {
    return "public";
  }
}

/**
 * Whether the repo is public or private. A `github.com` origin ignores
 * `MKSYNC_VISIBILITY` and fails closed; every other origin, including no
 * origin at all, reads the variable and defaults to public.
 */
export async function readVisibility(
  origin: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  deps: VisibilityDeps = DEFAULT_DEPS,
): Promise<Visibility> {
  const repo = origin === undefined ? undefined : parseGitHubOrigin(origin);
  if (repo === undefined) {
    // A github.com origin in a form the parser doesn't know (a trailing slash,
    // a user name, other case) must not reach the variable: it fails closed.
    if (origin !== undefined && GITHUB_HOST.test(origin)) {
      return "public";
    }
    return env[VISIBILITY_VARIABLE] === "private" ? "private" : "public";
  }
  const fromGh = await readFromGh(repo, deps.run);
  if (fromGh !== undefined) {
    return fromGh;
  }
  return await readFromApi(repo, deps.fetch);
}
