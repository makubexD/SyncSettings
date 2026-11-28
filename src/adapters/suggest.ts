/**
 * Suggested answers for value questions (contract "Sanitize and hydrate"):
 * each rule's `suggest` sources are tried in order and the first that answers
 * is the suggestion. A source runs at most once per call, with no shell and
 * under a time limit. A source that fails, prints nothing or prints a
 * placeholder doesn't answer. A suggestion is only ever shown as a question's
 * default.
 */

import { userInfo } from "node:os";
import type { SanitizeRule, SuggestSource } from "../core/config/types.ts";
import { holdsControlCharacter, trimAnswer } from "../core/answer.ts";
import { holdsPlaceholder } from "../core/values/hydrate.ts";
import type { Values } from "../core/values/sanitize.ts";
import { ghBinary } from "./gh.ts";
import { decode, run, which } from "./process.ts";
import { parseGitHubOrigin } from "./visibility.ts";

/** What one source run returned. */
export interface SuggestResult {
  readonly code: number;
  readonly stdout: string;
}

/** Runs one source's command; injected so the tests need no real git or gh. */
export type SuggestRunner = (argv: readonly string[]) => Promise<SuggestResult>;

type Env = Readonly<Record<string, string | undefined>>;

/** What the sources read from the machine; each part injectable for tests. */
export interface SuggestContext {
  /** The clone `origin-owner` reads; without it that source doesn't answer. */
  readonly repoRoot?: string;
  readonly runner?: SuggestRunner;
  readonly env?: Env;
  readonly platform?: NodeJS.Platform;
  /** The user whose passwd entry `passwd-name` reads. */
  readonly userName?: string;
  /** Finds `gh` on `PATH` for `gh-path`, as `mksync doctor` does. */
  readonly findGh?: (env: Env) => string | null;
}

/** What a source needs to build its command. */
export interface SourceContext {
  readonly env: Env;
  readonly repoRoot?: string;
  readonly platform: NodeJS.Platform;
  readonly userName?: string;
}

/** How long one source may take: `gh api` reaches the network. */
const SOURCE_TIMEOUT_MS = 5_000;

/** The code a source that could not start or ran past the limit reports. */
const NO_ANSWER_CODE = 1;

/** The line end a source prints after its answer. */
const TRAILING_LINE_END = /\r?\n$/;

/** The passwd field that holds the user's full name (GECOS), counted from 0. */
const PASSWD_NAME_FIELD = 4;

/** The command each source runs, or undefined when it has none here. */
export function sourceCommand(
  source: SuggestSource,
  context: SourceContext,
): readonly string[] | undefined {
  switch (source) {
    case "gh-login":
      return [ghBinary(context.env), "api", "user", "--jq", ".login"];
    case "gh-hosts-login":
      return [
        ghBinary(context.env),
        "config",
        "get",
        "-h",
        "github.com",
        "user",
      ];
    case "origin-owner":
      return context.repoRoot === undefined
        ? undefined
        : ["git", "-C", context.repoRoot, "remote", "get-url", "origin"];
    case "git-user-name":
      return ["git", "config", "--global", "user.name"];
    case "git-user-email":
      return ["git", "config", "--global", "user.email"];
    case "passwd-name":
      return passwdCommand(context);
    case "gh-path":
      // Found on PATH, not run.
      return undefined;
    default: {
      const unhandled: never = source;
      throw new Error(`unhandled suggest source: ${String(unhandled)}`);
    }
  }
}

function passwdCommand(context: SourceContext): readonly string[] | undefined {
  if (context.platform === "darwin") {
    return ["id", "-F"];
  }
  if (context.platform === "win32" || context.userName === undefined) {
    return undefined;
  }
  return ["getent", "passwd", context.userName];
}

/** The real runner: no shell, stderr dropped, killed after the limit. */
export async function runSource(
  argv: readonly string[],
): Promise<SuggestResult> {
  const result = await run(argv, {
    stdout: "pipe",
    stderr: "ignore",
    timeoutMs: SOURCE_TIMEOUT_MS,
  });
  if (result.timedOut === true || result.notStarted === true) {
    return { code: NO_ANSWER_CODE, stdout: "" };
  }
  return { code: result.code, stdout: decode(result.stdout) };
}

/** A value fit to show as a suggestion, or undefined. */
function usable(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value === "" ||
    holdsControlCharacter(value) ||
    holdsPlaceholder(value)
  ) {
    return undefined;
  }
  return value;
}

/** The part of a source's one line that is its answer. */
function answerPart(
  source: SuggestSource,
  line: string,
  platform: NodeJS.Platform,
): string | undefined {
  switch (source) {
    case "origin-owner":
      return parseGitHubOrigin(line)?.owner;
    case "passwd-name": {
      const name =
        platform === "darwin" ? line : line.split(":")[PASSWD_NAME_FIELD];
      return name === undefined
        ? undefined
        : trimAnswer(name.split(",")[0] ?? "");
    }
    default:
      return line;
  }
}

/** A source's answer from its run, or undefined when it can't be one. */
function answerOf(
  source: SuggestSource,
  result: SuggestResult,
  platform: NodeJS.Platform,
): string | undefined {
  if (result.code !== 0) {
    return undefined;
  }
  // One line, as a typed answer is: the line end goes, and a second line
  // refuses as a control character does.
  const line = usable(trimAnswer(result.stdout.replace(TRAILING_LINE_END, "")));
  return line === undefined
    ? undefined
    : usable(answerPart(source, line, platform));
}

/** This user's login name, or undefined when the system has no entry for it. */
function currentUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch (error) {
    // No passwd entry for this uid (a container): passwd-name doesn't answer.
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

/** A suggestion and the source that answered it. */
export interface SuggestionSource {
  readonly value: string;
  readonly source: SuggestSource;
}

/**
 * The suggestion for each placeholder whose rule names sources: the first of
 * its sources, in order, that answers, with that source. Each source runs at
 * most once however many rules name it, and only when a rule reaches it.
 */
export async function suggestionSources(
  rules: readonly SanitizeRule[],
  context: SuggestContext = {},
): Promise<Readonly<Record<string, SuggestionSource>>> {
  const runner = context.runner ?? runSource;
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const findGh = context.findGh ?? ((path: Env) => which(ghBinary(path), path));
  const userName =
    platform === "linux" ? (context.userName ?? currentUserName()) : undefined;
  const sourceContext: SourceContext = {
    env,
    platform,
    ...(context.repoRoot === undefined ? {} : { repoRoot: context.repoRoot }),
    ...(userName === undefined ? {} : { userName }),
  };
  const started = new Map<SuggestSource, Promise<string | undefined>>();

  function answer(source: SuggestSource): Promise<string | undefined> {
    const known = started.get(source);
    if (known !== undefined) {
      return known;
    }
    const argv = sourceCommand(source, sourceContext);
    // A runner that rejects gives no answer, as a failing source does.
    const pending =
      source === "gh-path"
        ? Promise.resolve(usable(findGh(env) ?? undefined))
        : argv === undefined
          ? Promise.resolve(undefined)
          : runner(argv).then(
              (result) => answerOf(source, result, platform),
              () => undefined,
            );
    started.set(source, pending);
    return pending;
  }

  async function firstAnswer(
    sources: readonly SuggestSource[],
  ): Promise<SuggestionSource | undefined> {
    for (const source of sources) {
      // Sequential on purpose: a later source runs only when this one fails.
      const value = await answer(source);
      if (value !== undefined) {
        return { value, source };
      }
    }
    return undefined;
  }

  const answers = await Promise.all(
    rules.map(async (rule) => ({
      placeholder: rule.placeholder,
      answered: await firstAnswer(rule.suggest ?? []),
    })),
  );
  const found: Record<string, SuggestionSource> = {};
  for (const { placeholder, answered } of answers) {
    if (answered !== undefined && found[placeholder] === undefined) {
      found[placeholder] = answered;
    }
  }
  return found;
}

/** The suggestion for each placeholder, without its source. */
export async function suggestions(
  rules: readonly SanitizeRule[],
  context: SuggestContext = {},
): Promise<Values> {
  const found = await suggestionSources(rules, context);
  return Object.fromEntries(
    Object.entries(found).map(([placeholder, { value }]) => [
      placeholder,
      value,
    ]),
  );
}
