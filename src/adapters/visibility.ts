/**
 * Read whether the repo may receive profiles, machine records and values
 * (design "Public-repo guard"): a `github.com` origin is asked through `gh`,
 * then the public GitHub API, and every failure counts as public so the guard
 * fails closed. An SSH origin is resolved with `ssh -G` first: an alias of
 * `github.com` is asked the same way, and a host that is unsafe or cannot be
 * resolved is public. Any other origin follows `MKSYNC_VISIBILITY`, which is
 * ignored for `github.com` so it cannot switch the guard off on the real repo.
 */

import { ghEnv, ownerToken } from "./gh.ts";
import { decode, run } from "./process.ts";

/** Whether the repo can receive profiles, machine records and values. */
export type RemoteVisibility = "public" | "private" | "unknown";

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

/** What the reader reaches outside itself: `gh`, `ssh` and the GitHub API. */
export interface VisibilityDeps {
  /** Run one command; the signal aborts it once its time limit passes. */
  readonly run: (
    command: string,
    args: readonly string[],
    signal?: AbortSignal,
    env?: Readonly<Record<string, string | undefined>>,
  ) => Promise<CommandOutput>;
  /** The owner token `gh` runs with; none when omitted. */
  readonly ownerToken?: (owner: string) => Promise<string | undefined>;
  readonly fetch: (url: string, signal: AbortSignal) => Promise<ApiReply>;
  /** How long `gh` and the API may take; `API_TIMEOUT_MS` when omitted. */
  readonly timeoutMs?: number;
}

/** One parsed `github.com` origin: the repo the guard will ask about. */
interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
}

/** One parsed SSH origin: the host or alias to resolve and the repo path. */
interface SshOrigin {
  readonly host: string;
  readonly path: string;
}

const GITHUB_HOST_NAME = "github.com";

/** The origin forms that name a repo on `github.com`. */
const GITHUB_ORIGIN_PREFIXES = [
  `https://${GITHUB_HOST_NAME}/`,
  `git@${GITHUB_HOST_NAME}:`,
  `ssh://git@${GITHUB_HOST_NAME}/`,
] as const;

/**
 * `<owner>/<repo>`, with an optional `.git` suffix on the repo. The owner must
 * start with a letter or digit so an option-like `-o` never names a repo.
 */
const OWNER_REPO = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/** Any origin naming the `github.com` host, parsed or not. */
const GITHUB_HOST = /(^|[@/.])github\.com([:/]|$)/i;

/** The `ssh://[user@]host[:port]/path` origin form. */
const SSH_URL = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/;

/** The scp origin form `[user@]host:path`, whose host has no slash. */
const SCP_ORIGIN = /^(?:[^@/]+@)?([^/:]+):(.*)$/;

/** The lowered host name `ssh -G` prints. */
const SSH_HOSTNAME_PREFIX = "hostname ";

const GITHUB_API = "https://api.github.com/repos/";

/** How long the GitHub API answer may take before it counts as public. */
const API_TIMEOUT_MS = 5_000;

const OK = 200;

/** A command that could not start has no exit code; report it as -1. */
const FAILED_TO_START = -1;

/** git's exit code for a remote that doesn't exist. */
const NO_SUCH_REMOTE = 2;

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

/**
 * Run one command with an argument array and no shell, as `git.ts` does. When
 * the signal fires the child is killed and the run reports `FAILED_TO_START`,
 * so a `gh` that hangs counts as "gh cannot tell" and the API is asked.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<CommandOutput> {
  const result = await run([command, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    ...(env === undefined ? {} : { env }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.timedOut === true || result.notStarted === true) {
    // A missing or hung `gh` is "gh cannot tell", so the API is asked.
    return { code: FAILED_TO_START, stdout: "" };
  }
  return { code: result.code, stdout: decode(result.stdout) };
}

const DEFAULT_DEPS: VisibilityDeps = {
  run: runCommand,
  ownerToken,
  fetch: async (url, signal) => await fetch(url, { signal }),
};

/** The `owner/repo` a text names, or `undefined` when it names none. */
function parseOwnerRepo(text: string): GitHubRepo | undefined {
  const match = OWNER_REPO.exec(text);
  if (match === null) {
    return undefined;
  }
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) {
    return undefined;
  }
  return { owner, repo };
}

/**
 * The `owner/repo` a `github.com` origin names, or `undefined` when the origin
 * is not one of its HTTPS or SSH forms.
 */
export function parseGitHubOrigin(origin: string): GitHubRepo | undefined {
  for (const prefix of GITHUB_ORIGIN_PREFIXES) {
    if (origin.startsWith(prefix)) {
      return parseOwnerRepo(origin.slice(prefix.length));
    }
  }
  return undefined;
}

/**
 * The host and repo path an SSH origin names, or `undefined` for any other
 * origin. A Windows drive path such as `C:\x` is not SSH: its host is one
 * character long.
 */
function parseSshOrigin(origin: string): SshOrigin | undefined {
  if (origin.startsWith("ssh://")) {
    const match = SSH_URL.exec(origin);
    if (match === null) {
      return undefined;
    }
    const host = match[1];
    const path = match[2];
    if (host === undefined || path === undefined) {
      return undefined;
    }
    return { host, path };
  }
  if (origin.includes("://")) {
    return undefined;
  }
  const match = SCP_ORIGIN.exec(origin);
  if (match === null) {
    return undefined;
  }
  const host = match[1];
  const path = match[2];
  if (host === undefined || path === undefined || host.length <= 1) {
    return undefined;
  }
  return { host, path };
}

/**
 * The real host an SSH host or alias names, from `ssh -G <host>`; `undefined`
 * when it fails or prints no host name, so the caller fails closed.
 */
async function resolveSshHost(
  host: string,
  run: VisibilityDeps["run"],
): Promise<string | undefined> {
  let output: CommandOutput;
  try {
    output = await run("ssh", ["-G", host]);
  } catch {
    return undefined;
  }
  if (output.code !== 0) {
    return undefined;
  }
  for (const line of output.stdout.split("\n")) {
    if (line.startsWith(SSH_HOSTNAME_PREFIX)) {
      const hostname = line
        .slice(SSH_HOSTNAME_PREFIX.length)
        .trim()
        .toLowerCase();
      return hostname === "" ? undefined : hostname;
    }
  }
  return undefined;
}

/**
 * `gh repo view github.com/<owner>/<repo> --json visibility`, host-qualified
 * so a same-named repo on another host cannot answer; `undefined` when `gh` is
 * missing, failing, not signed in, or answers anything but a visibility. An
 * `INTERNAL` repo is private: it is not public. The signal stops a hanging
 * `gh` after `timeoutMs`, which counts as "gh cannot tell".
 */
async function readFromGh(
  repo: GitHubRepo,
  run: VisibilityDeps["run"],
  timeoutMs: number,
  token?: string,
): Promise<RemoteVisibility | undefined> {
  let output: CommandOutput;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    output = await run(
      "gh",
      [
        "repo",
        "view",
        `${GITHUB_HOST_NAME}/${repo.owner}/${repo.repo}`,
        "--json",
        "visibility",
      ],
      signal,
      token === undefined ? undefined : ghEnv(token),
    );
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
  timeoutMs: number,
): Promise<RemoteVisibility> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
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

/** Ask `gh` about a parsed repo, then the API; both fail closed to public. */
async function askGitHub(
  repo: GitHubRepo,
  deps: VisibilityDeps,
): Promise<RemoteVisibility> {
  const timeoutMs = deps.timeoutMs ?? API_TIMEOUT_MS;
  const token = await deps.ownerToken?.(repo.owner);
  const fromGh = await readFromGh(repo, deps.run, timeoutMs, token);
  if (fromGh !== undefined) {
    return fromGh;
  }
  return await readFromApi(repo, deps.fetch, timeoutMs);
}

/** Follow `MKSYNC_VISIBILITY`, defaulting to public. */
function readVariable(
  env: Readonly<Record<string, string | undefined>>,
): RemoteVisibility {
  return env[VISIBILITY_VARIABLE] === "private" ? "private" : "public";
}

/**
 * The visibility with no push URL to read: only the variable can answer, and
 * an unset one leaves the guard unable to tell.
 */
function readVariableOrUnknown(
  env: Readonly<Record<string, string | undefined>>,
): RemoteVisibility {
  return env[VISIBILITY_VARIABLE] === "private" ? "private" : "unknown";
}

/**
 * The visibility an SSH origin names: an alias of `github.com` is asked as
 * `github.com` and never reads the variable; any other resolved host keeps the
 * fallback; a host that is unsafe or cannot be resolved is public.
 */
async function readSshOrigin(
  ssh: SshOrigin,
  env: Readonly<Record<string, string | undefined>>,
  deps: VisibilityDeps,
): Promise<RemoteVisibility> {
  if (ssh.host.length === 0 || ssh.host.startsWith("-")) {
    return "public";
  }
  const hostname = await resolveSshHost(ssh.host, deps.run);
  if (hostname === undefined) {
    return "public";
  }
  if (hostname === GITHUB_HOST_NAME) {
    const repo = parseOwnerRepo(ssh.path.replace(/^\//, ""));
    return repo === undefined ? "public" : await askGitHub(repo, deps);
  }
  if (GITHUB_HOST.test(hostname)) {
    return "public";
  }
  return readVariable(env);
}

/**
 * The visibility one push URL names. A `github.com` origin, directly or
 * through an SSH host alias, ignores `MKSYNC_VISIBILITY` and fails closed;
 * every other origin reads the variable and defaults to public. An SSH host
 * that is unsafe or cannot be resolved is public, and no other origin ever
 * runs `ssh`. An entry that names no URL at all leaves the guard unable to
 * tell.
 */
async function readOneVisibility(
  origin: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: VisibilityDeps,
): Promise<RemoteVisibility> {
  if (origin.trim() === "") {
    return "unknown";
  }
  const repo = parseGitHubOrigin(origin);
  if (repo !== undefined) {
    return await askGitHub(repo, deps);
  }
  const ssh = parseSshOrigin(origin);
  if (ssh !== undefined) {
    return await readSshOrigin(ssh, env, deps);
  }
  // A github.com origin in a form the parser doesn't know (a trailing slash,
  // a user name, other case) must not reach the variable: it fails closed.
  if (GITHUB_HOST.test(origin)) {
    return "public";
  }
  return readVariable(env);
}

/**
 * The owner of the clone's `origin` URL as configured (`git config --get
 * remote.origin.url`, before any `insteadOf` rewrite), or `undefined` when it
 * is not a `github.com` URL or git cannot say.
 */
export async function originOwner(
  repoRoot: string,
): Promise<string | undefined> {
  const result = await run(
    ["git", "-C", repoRoot, "config", "--get", "remote.origin.url"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.code !== 0) {
    return undefined;
  }
  return parseGitHubOrigin(decode(result.stdout).trim())?.owner;
}

/**
 * Every push URL a `git remote get-url --push --all origin` run names, one per
 * trimmed, non-empty stdout line. An exit 2 means the remote doesn't exist, so
 * no URL answers; `undefined` (git didn't start) or any other failure leaves
 * the guard unable to tell.
 */
export function originUrls(
  output: CommandOutput | undefined,
): readonly string[] | undefined {
  if (output === undefined) {
    return undefined;
  }
  if (output.code !== 0) {
    return output.code === NO_SUCH_REMOTE ? [] : undefined;
  }
  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Whether the repo is public or private, from every push URL `origin` names
 * (`git remote get-url --push --all origin`). Any public URL makes the repo
 * public; a non-empty list is private only when every URL reads private; a
 * URL that can't tell, or no URL at all, is unknown. With no URL only
 * `MKSYNC_VISIBILITY` can answer, keeping its override as it was; a read git
 * cannot make (`undefined`) is unknown whatever the variable says.
 */
export async function readVisibility(
  origins: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
  deps: VisibilityDeps = DEFAULT_DEPS,
): Promise<RemoteVisibility> {
  if (origins === undefined) {
    return "unknown";
  }
  if (origins.length === 0) {
    return readVariableOrUnknown(env);
  }
  const readings = await Promise.all(
    origins.map(async (origin) => await readOneVisibility(origin, env, deps)),
  );
  if (readings.includes("public")) {
    return "public";
  }
  return readings.every((reading) => reading === "private")
    ? "private"
    : "unknown";
}
