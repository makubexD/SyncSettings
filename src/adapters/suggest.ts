/**
 * Suggested answers for value questions (contract "Sanitize and hydrate"):
 * each rule's `suggest` source is run once, with no shell and under a time
 * limit. A source that fails, prints nothing or prints a placeholder gives no
 * suggestion. A suggestion is only ever shown as a question's default.
 */

import type { SanitizeRule, SuggestSource } from "../core/config/types.ts";
import { trimAnswer } from "../core/answer.ts";
import { holdsPlaceholder } from "../core/values/hydrate.ts";
import type { Values } from "../core/values/sanitize.ts";
import { ghBinary } from "./gh.ts";
import { decode, run } from "./process.ts";

/** What one source run returned. */
export interface SuggestResult {
  readonly code: number;
  readonly stdout: string;
}

/** Runs one source's command; injected so the tests need no real git or gh. */
export type SuggestRunner = (argv: readonly string[]) => Promise<SuggestResult>;

/** How long one source may take: `gh api` reaches the network. */
const SOURCE_TIMEOUT_MS = 5_000;

/** The code a source that could not start or ran past the limit reports. */
const NO_ANSWER_CODE = 1;

/** The line end a source prints after its answer. */
const TRAILING_LINE_END = /\r?\n$/;

/** The command each source runs. */
export function sourceCommand(
  source: SuggestSource,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  switch (source) {
    case "gh-login":
      return [ghBinary(env), "api", "user", "--jq", ".login"];
    case "git-user-name":
      return ["git", "config", "--global", "user.name"];
    case "git-user-email":
      return ["git", "config", "--global", "user.email"];
    default: {
      const unhandled: never = source;
      throw new Error(`unhandled suggest source: ${String(unhandled)}`);
    }
  }
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

/** A source's answer: trimmed output, or undefined when it can't be one. */
function suggestionOf(result: SuggestResult): string | undefined {
  if (result.code !== 0) {
    return undefined;
  }
  // One line, as a typed answer is: the line end goes, a second line refuses.
  const value = trimAnswer(result.stdout.replace(TRAILING_LINE_END, ""));
  if (value === "" || value.includes("\n") || holdsPlaceholder(value)) {
    return undefined;
  }
  return value;
}

/**
 * The suggestion for each placeholder whose rule names a source, each source
 * run once however many rules name it.
 */
export async function suggestions(
  rules: readonly SanitizeRule[],
  runner: SuggestRunner = runSource,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Values> {
  const sources = new Map<SuggestSource, Promise<string | undefined>>();
  const pending: [string, Promise<string | undefined>][] = [];
  for (const rule of rules) {
    const source = rule.suggest;
    if (source === undefined) {
      continue;
    }
    let answer = sources.get(source);
    if (answer === undefined) {
      answer = runner(sourceCommand(source, env)).then(suggestionOf);
      sources.set(source, answer);
    }
    pending.push([rule.placeholder, answer]);
  }
  const found: Record<string, string> = {};
  for (const [placeholder, answer] of pending) {
    const value = await answer;
    if (value !== undefined && found[placeholder] === undefined) {
      found[placeholder] = value;
    }
  }
  return found;
}
