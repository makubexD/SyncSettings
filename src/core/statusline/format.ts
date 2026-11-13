/**
 * The statusline's text, ported from `dotfiles/linux/claude/statusline.sh`.
 *
 * Pure: the payload comes from Claude Code's JSON on stdin and the facts from
 * the adapter (`src/adapters/statusline.ts`); nothing here reads the clock,
 * the environment, git or the file system. Contract "Statusline (program
 * only)".
 */

const RESET = "\u001b[0m";
const CYAN = "\u001b[96m";
const YELLOW = "\u001b[93m";
const MAGENTA = "\u001b[95m";
const BLUE = "\u001b[94m";
const GREEN = "\u001b[92m";
const YELLOW_DIM = "\u001b[33m";
const RED = "\u001b[91m";
const GRAY = "\u001b[90m";

const SEPARATOR = ` ${GRAY}|${RESET} `;
const UNAVAILABLE = "Statusline data unavailable";
const DEFAULT_OUTPUT_STYLE = "default";
const WORKER_LABEL = "WORKER";

const BAR_SIZE = 10;
const PERCENT_PER_BAR_CELL = 10;
const PERCENT_GREEN_ABOVE = 60;
const PERCENT_YELLOW_FROM = 30;

const TOKEN_KILO = 1_000;
const TOKEN_MEGA = 1_000_000;

const COST_GREEN_UNDER = 0.5;
const COST_YELLOW_UP_TO = 2;

const DEFAULT_CLEAR_AT = 200_000;
const CLEAR_WINDOW_PERCENT = 70;
const PERCENT_DIVISOR = 100;

const MEBIBYTES_PER_GIBIBYTE = 1024;

/** The file names that set the project type, in the script's order. */
const PROJECT_TYPES: readonly (readonly [string, string])[] = [
  ["pyproject.toml", "Python"],
  ["package.json", "Node.js"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
];

const DOT_NET_EXTENSIONS: readonly string[] = [".csproj", ".sln"];

/** `git log --format=%cr` long units, shortened as the script's `sed` does. */
const AGE_RULES: readonly (readonly [RegExp, string])[] = [
  [/ years? ago/, "y"],
  [/ months? ago/, "mo"],
  [/ weeks? ago/, "w"],
  [/ days? ago/, "d"],
  [/ hours? ago/, "h"],
  [/ minutes? ago/, "m"],
  [/ seconds? ago/, "s"],
];

/** The payload fields the script reads. Missing or null fields are empty. */
export interface StatusPayload {
  /** `.model.display_name`. */
  readonly model: string;
  /** `.workspace.project_dir`. */
  readonly projectDir: string;
  /** `.cwd`, else `.workspace.current_dir`, else `.workspace.project_dir`. */
  readonly directory: string;
  /** `.cost.total_cost_usd`. */
  readonly cost: number | undefined;
  /** `.context_window.remaining_percentage`. */
  readonly remainingPercentage: number | undefined;
  /** `.context_window.used_percentage`. */
  readonly usedPercentage: number | undefined;
  /** `.context_window.total_input_tokens`, the tokens used. */
  readonly totalInputTokens: number | undefined;
  /** `.context_window.context_window_size`. */
  readonly contextWindowSize: number | undefined;
  /** `.context_window.current_usage.cache_creation_input_tokens`, 0 if missing. */
  readonly cacheCreationInputTokens: number;
  /** `.context_window.current_usage.cache_read_input_tokens`, 0 if missing. */
  readonly cacheReadInputTokens: number;
  /** `.output_style.name`. */
  readonly outputStyle: string;
  /** `.session_id`. */
  readonly sessionId: string;
}

/** What the adapter reads from git, undecorated. */
export interface GitFacts {
  readonly branch: string;
  /** `git status --porcelain` listed anything. */
  readonly dirty: boolean;
  /** Commits ahead of the upstream; undefined when there is no upstream. */
  readonly ahead?: number;
  /** Commits behind the upstream; undefined when there is no upstream. */
  readonly behind?: number;
  /** Raw `git log -1 --format=%cr`, e.g. `3 hours ago`; undefined with no commit. */
  readonly age?: string;
  /** Insertions across staged and unstaged changes, binary files skipped. */
  readonly insertions: number;
  /** Deletions across staged and unstaged changes, binary files skipped. */
  readonly deletions: number;
  /** Untracked file count. */
  readonly untracked: number;
}

/** What the adapter reads from the system, as raw data, not formatted text. */
export interface StatusFacts {
  /** Local time as `HH:MM`. */
  readonly time: string;
  /** File names in the project folder; undefined when it is not a folder. */
  readonly projectFiles?: readonly string[];
  /** Whether the project folder holds a `.venv` folder. */
  readonly hasVenvDir?: boolean;
  /** `VIRTUAL_ENV`. */
  readonly virtualEnv?: string;
  /** `CONDA_DEFAULT_ENV`. */
  readonly condaEnv?: string;
  /** Undefined outside a git repository. */
  readonly git?: GitFacts;
  /** The one-minute load average text; undefined when unavailable (Windows). */
  readonly load?: string;
  /** Memory in MiB; undefined when unavailable (Windows). */
  readonly mem?: { readonly usedMiB: number; readonly totalMiB: number };
  /** `~/.claude/state/worker-mode` exists. */
  readonly workerMode?: boolean;
  /** `CONTEXT_CLEAR_AT`; undefined takes the contract's default. */
  readonly clearAt?: number;
}

/** Read the script's payload fields from Claude Code's JSON text, never throwing. */
export function parsePayload(text: string): StatusPayload {
  const raw = parseJsonObject(text);
  const model = asObject(raw?.model);
  const workspace = asObject(raw?.workspace);
  const cost = asObject(raw?.cost);
  const contextWindow = asObject(raw?.context_window);
  const currentUsage = asObject(contextWindow?.current_usage);
  const outputStyle = asObject(raw?.output_style);

  return {
    model: asText(model?.display_name),
    projectDir: asText(workspace?.project_dir),
    directory:
      asString(raw?.cwd) ??
      asString(workspace?.current_dir) ??
      asString(workspace?.project_dir) ??
      "",
    cost: asNumber(cost?.total_cost_usd),
    remainingPercentage: asNumber(contextWindow?.remaining_percentage),
    usedPercentage: asNumber(contextWindow?.used_percentage),
    totalInputTokens: asNumber(contextWindow?.total_input_tokens),
    contextWindowSize: asNumber(contextWindow?.context_window_size),
    cacheCreationInputTokens: asNumber(currentUsage?.cache_creation_input_tokens) ?? 0,
    cacheReadInputTokens: asNumber(currentUsage?.cache_read_input_tokens) ?? 0,
    outputStyle: asText(outputStyle?.name),
    sessionId: asText(raw?.session_id),
  };
}

/** The whole line, ending with the newline the script's final `printf` writes. */
export function statusLine(payload: StatusPayload, facts: StatusFacts): string {
  const parts: string[] = [];
  if (facts.time) parts.push(paint(GRAY, facts.time));
  if (payload.model) parts.push(paint(CYAN, payload.model));

  const venv = virtualEnvName(payload.projectDir, facts);
  if (venv) parts.push(paint(GREEN, venv));

  const type = projectType(facts.projectFiles);
  if (type) parts.push(paint(BLUE, type));

  const directory = directoryName(payload.directory);
  if (directory) parts.push(paint(YELLOW, directory));

  if (facts.git?.branch) {
    parts.push(paint(MAGENTA, gitBranchText(facts.git)));
    const changes = gitChangesText(facts.git);
    if (changes) parts.push(paint(YELLOW, changes));
  }

  const costAndContext = costAndContextText(payload, facts);
  if (costAndContext) parts.push(costAndContext);

  const cached = cachedText(payload);
  if (cached) parts.push(paint(CYAN, cached));

  if (facts.load) parts.push(paint(CYAN, `Load: ${facts.load}`));
  if (facts.mem) parts.push(paint(CYAN, `Mem: ${memoryText(facts.mem)}`));

  if (payload.outputStyle && payload.outputStyle !== DEFAULT_OUTPUT_STYLE) {
    parts.push(paint(BLUE, payload.outputStyle));
  }
  if (facts.workerMode) parts.push(paint(GREEN, WORKER_LABEL));

  if (parts.length === 0) return `${UNAVAILABLE}\n`;
  return `${parts.join(SEPARATOR)}\n`;
}

/** `[██████░░░░]`: one filled cell per ten percent, clamped to the bar. */
export function progressBar(percent: number): string {
  const filled = Math.min(BAR_SIZE, Math.max(0, Math.trunc(percent / PERCENT_PER_BAR_CELL)));
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SIZE - filled)}]`;
}

/** Token count as the script's `fmt_tokens`: lowercase `k`/`M`, trailing `.0` dropped. */
export function formatTokens(tokens: number): string {
  if (tokens >= TOKEN_MEGA) return `${dropTrailingZero(formatFixed(tokens / TOKEN_MEGA, 1))}M`;
  if (tokens >= TOKEN_KILO) return `${dropTrailingZero(formatFixed(tokens / TOKEN_KILO, 1))}k`;
  return `${Math.floor(tokens + 0.5)}`;
}

function paint(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

function dropTrailingZero(value: string): string {
  return value.replace(/\.0$/, "");
}

/** `printf '%.Nf'`: C rounds half to even, which `toFixed` does not. */
function formatFixed(value: number, digits: number): string {
  const scale = 10 ** digits;
  return (roundHalfEven(value * scale) / scale).toFixed(digits);
}

/** `printf '%.0f'`: C's round-half-to-even, unlike JavaScript's `Math.round`. */
function roundPercent(value: number): number {
  return roundHalfEven(value);
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The directory's last part, with at most one trailing slash dropped first. */
function directoryName(directory: string): string {
  const stripped = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return afterLastSlash(stripped);
}

function afterLastSlash(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

function virtualEnvName(projectDir: string, facts: StatusFacts): string {
  if (
    projectDir &&
    facts.hasVenvDir === true &&
    facts.projectFiles?.includes("pyproject.toml") === true
  ) {
    return ".venv";
  }
  if (facts.virtualEnv) return afterLastSlash(facts.virtualEnv);
  if (facts.condaEnv) return `conda:${facts.condaEnv}`;
  return "";
}

function projectType(projectFiles: readonly string[] | undefined): string {
  if (!projectFiles) return "";
  for (const [fileName, label] of PROJECT_TYPES) {
    if (projectFiles.includes(fileName)) return label;
  }
  if (projectFiles.some((fileName) => DOT_NET_EXTENSIONS.some((ext) => fileName.endsWith(ext)))) {
    return ".NET";
  }
  return "";
}

function gitBranchText(git: GitFacts): string {
  let text = git.dirty ? `${git.branch}*` : git.branch;
  if (git.ahead !== undefined && git.ahead > 0) text += ` ↑${git.ahead}`;
  if (git.behind !== undefined && git.behind > 0) text += ` ↓${git.behind}`;
  if (git.age) text += ` ${shortenAge(git.age)}`;
  return text;
}

function shortenAge(age: string): string {
  let shortened = age;
  for (const [pattern, replacement] of AGE_RULES) {
    shortened = shortened.replace(pattern, replacement);
  }
  return shortened;
}

function gitChangesText(git: GitFacts): string {
  const changes: string[] = [];
  if (git.insertions > 0 || git.deletions > 0) {
    changes.push(`(+${git.insertions},-${git.deletions})`);
  }
  if (git.untracked > 0) changes.push(`${git.untracked}?`);
  return changes.join(" ");
}

function costAndContextText(payload: StatusPayload, facts: StatusFacts): string {
  const cost = costText(payload.cost);
  const context = contextText(payload, facts);
  if (!cost) return context;
  if (!context) return cost;
  return `${cost}${SEPARATOR}${context}`;
}

function costText(cost: number | undefined): string {
  if (cost === undefined) return "";
  const color =
    cost < COST_GREEN_UNDER ? GREEN : cost <= COST_YELLOW_UP_TO ? YELLOW_DIM : RED;
  return paint(color, `Cost: $${formatFixed(cost, 2)}`);
}

function contextText(payload: StatusPayload, facts: StatusFacts): string {
  const percent = contextPercent(payload);
  if (percent === undefined) return "";

  const color =
    percent > PERCENT_GREEN_ABOVE
      ? GREEN
      : percent >= PERCENT_YELLOW_FROM
        ? YELLOW_DIM
        : RED;
  const bar = progressBar(percent);
  const { totalInputTokens, contextWindowSize } = payload;
  const hasCounts = totalInputTokens !== undefined && contextWindowSize !== undefined;
  const context =
    hasCounts && contextWindowSize !== 0
      ? `Context: ${bar} ${formatTokens(totalInputTokens)}/${formatTokens(contextWindowSize)} (${percent}%)`
      : `Context: ${bar} ${percent}%`;

  if (tokensReachClear(totalInputTokens, contextWindowSize, facts.clearAt)) {
    return paint(color, `${context} ${YELLOW_DIM}CLEAR${RESET}`);
  }
  return paint(color, context);
}

/** The remaining percent the script computes: rounded, or 100 minus the used percent. */
function contextPercent(payload: StatusPayload): number | undefined {
  if (payload.remainingPercentage !== undefined) {
    return roundPercent(payload.remainingPercentage);
  }
  if (payload.usedPercentage !== undefined) return roundPercent(100 - payload.usedPercentage);
  return undefined;
}

/** `CONTEXT_CLEAR_AT`, lowered to 70% of a smaller window, as the script does. */
function clearLimit(windowSize: number | undefined, configured: number | undefined): number {
  let limit = configured ?? DEFAULT_CLEAR_AT;
  if (windowSize !== undefined && Number.isInteger(windowSize) && windowSize > 0) {
    const windowLimit = Math.trunc((windowSize * CLEAR_WINDOW_PERCENT) / PERCENT_DIVISOR);
    if (windowLimit < limit) limit = windowLimit;
  }
  return limit;
}

function tokensReachClear(
  totalInputTokens: number | undefined,
  contextWindowSize: number | undefined,
  configured: number | undefined,
): boolean {
  if (totalInputTokens === undefined) return false;
  if (!Number.isInteger(totalInputTokens) || totalInputTokens < 0) return false;
  return totalInputTokens >= clearLimit(contextWindowSize, configured);
}

function cachedText(payload: StatusPayload): string {
  const cached =
    Math.trunc(payload.cacheCreationInputTokens) + Math.trunc(payload.cacheReadInputTokens);
  return cached > 0 ? `Cached: ${formatTokens(cached)}` : "";
}

function memoryText(mem: { readonly usedMiB: number; readonly totalMiB: number }): string {
  const used = formatFixed(mem.usedMiB / MEBIBYTES_PER_GIBIBYTE, 1);
  const total = formatFixed(mem.totalMiB / MEBIBYTES_PER_GIBIBYTE, 1);
  return `${used}G/${total}G`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Contract: a payload that isn't JSON yields empty fields, never an error.
    return undefined;
  }
  return asObject(parsed);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asText(value: unknown): string {
  return asString(value) ?? "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
