import { trimAnswer } from "../answer.ts";
import type { ConfigError, Result, SanitizeRule } from "../config/types.ts";
import {
  encodeUtf8,
  indexOfBytes,
  jsonStringBody,
  placeholderToken,
  placeholdersByLength,
  replaceAllBytes,
} from "./sanitize.ts";
import type { Values } from "./sanitize.ts";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface ValueOwner {
  readonly profile: string;
  readonly machine: string;
}

export interface HydrateOptions {
  readonly json: boolean;
  readonly owner?: ValueOwner;
}

function missingValueMessage(placeholder: string, owner?: ValueOwner): string {
  if (owner !== undefined) {
    return `missing value for ${placeholder}: add it to profile ${owner.profile} or machine ${owner.machine}`;
  }
  return `missing value for ${placeholder}: add it to .user-values.json`;
}

function missingValue(
  placeholder: string,
  owner?: ValueOwner,
): Result<never, ConfigError> {
  return {
    ok: false,
    error: {
      message: missingValueMessage(placeholder, owner),
      code: 1,
      placeholder,
    },
  };
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/** Lines as bash `mapfile -t` reads them: no extra element after a final newline. */
function splitLines(content: Uint8Array): readonly Uint8Array[] {
  if (content.length === 0) {
    return [];
  }
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === NEWLINE) {
      lines.push(content.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < content.length) {
    lines.push(content.subarray(start));
  }
  return lines;
}

function stripCarriageReturn(line: Uint8Array): Uint8Array {
  if (line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN) {
    return line.subarray(0, line.length - 1);
  }
  return line;
}

function startsWithBytes(content: Uint8Array, prefix: Uint8Array): boolean {
  return (
    content.length >= prefix.length && indexOfBytes(content, prefix, 0) === 0
  );
}

function endsWithBytes(content: Uint8Array, suffix: Uint8Array): boolean {
  if (content.length < suffix.length) {
    return false;
  }
  const from = content.length - suffix.length;
  return indexOfBytes(content, suffix, from) === from;
}

/**
 * Values inferred from a local file against its repo file (contract "Inference
 * on import"). Text between a repo line's placeholder and its prefix and
 * suffix, matched against the local line at the same position.
 */
export function inferValues(
  local: Uint8Array,
  repo: Uint8Array,
  rules: readonly SanitizeRule[],
): Values {
  const localLines = splitLines(local).map(stripCarriageReturn);
  const repoLines = splitLines(repo).map(stripCarriageReturn);
  const count = Math.min(localLines.length, repoLines.length);
  const inferred = new Map<string, string>();

  for (let i = 0; i < count; i++) {
    const repoLine = repoLines[i];
    const localLine = localLines[i];
    if (repoLine === undefined || localLine === undefined) {
      continue;
    }
    for (const rule of rules) {
      const placeholder = rule.placeholder;
      const placeholderBytes = encodeUtf8(placeholder);
      if (placeholderBytes.length === 0) {
        continue;
      }
      const repoPlaceholder = indexOfBytes(repoLine, placeholderBytes, 0);
      if (repoPlaceholder === -1) {
        continue;
      }
      if (indexOfBytes(localLine, placeholderBytes, 0) !== -1) {
        continue;
      }
      const prefix = repoLine.subarray(0, repoPlaceholder);
      const suffix = repoLine.subarray(
        repoPlaceholder + placeholderBytes.length,
      );
      if (!startsWithBytes(localLine, prefix)) {
        continue;
      }
      if (!endsWithBytes(localLine, suffix)) {
        continue;
      }
      if (localLine.length < prefix.length + suffix.length) {
        continue;
      }
      if (inferred.has(placeholder)) {
        continue;
      }
      const valueBytes = localLine.subarray(
        prefix.length,
        localLine.length - suffix.length,
      );
      let value = new TextDecoder().decode(valueBytes);
      if (rule.escapeBackslashes === true) {
        value = value.replaceAll("\\\\", "\\");
      }
      if (value.length === 0) {
        continue;
      }
      inferred.set(placeholder, value);
    }
  }

  return Object.fromEntries(inferred);
}

/**
 * Contract "Inference", export: the values a local file holds, read without
 * trusting line positions, since export runs on a file that has drifted from
 * the repo. A repo line holding a placeholder gives a value only when exactly
 * one local line, anywhere in the file, fits its prefix and suffix. A
 * placeholder is `null` (ambiguous, never inferred) when a repo line fits more
 * than one local line or two repo lines give different values. A repo line no
 * local line fits gives nothing.
 */
export function inferValuesUnique(
  local: Uint8Array,
  repo: Uint8Array,
  rules: readonly SanitizeRule[],
): ReadonlyMap<string, string | null> {
  const localLines = splitLines(local).map(stripCarriageReturn);
  const repoLines = splitLines(repo).map(stripCarriageReturn);
  const inferred = new Map<string, string | null>();

  for (const rule of rules) {
    const placeholder = rule.placeholder;
    const placeholderBytes = encodeUtf8(placeholder);
    if (placeholderBytes.length === 0 || inferred.get(placeholder) === null) {
      continue;
    }
    for (const repoLine of repoLines) {
      const at = indexOfBytes(repoLine, placeholderBytes, 0);
      if (at === -1) {
        continue;
      }
      const prefix = repoLine.subarray(0, at);
      const suffix = repoLine.subarray(at + placeholderBytes.length);
      const fits = new Set<string>();
      for (const localLine of localLines) {
        if (
          localLine.length <= prefix.length + suffix.length ||
          indexOfBytes(localLine, placeholderBytes, 0) !== -1 ||
          !startsWithBytes(localLine, prefix) ||
          !endsWithBytes(localLine, suffix)
        ) {
          continue;
        }
        let value = new TextDecoder().decode(
          localLine.subarray(prefix.length, localLine.length - suffix.length),
        );
        if (rule.escapeBackslashes === true) {
          value = value.replaceAll("\\\\", "\\");
        }
        fits.add(value);
      }
      if (fits.size === 0) {
        continue;
      }
      const [value] = fits;
      const known = inferred.get(placeholder);
      if (fits.size > 1 || (known !== undefined && known !== value)) {
        inferred.set(placeholder, null);
        break;
      }
      inferred.set(placeholder, value ?? null);
    }
  }

  return inferred;
}

/**
 * The non-interactive path of the bash engine's `request_values`: a cached
 * value wins, then one inferred from the local file, then the rule's `default`,
 * then the environment variable its `defaultEnv` names. A missing value stops
 * the run with exit 1. The `defaultEnv` name itself is checked by the config
 * parser, as the bash engine checks it before reading values.
 */
export function resolveValues(
  rules: readonly SanitizeRule[],
  cached: Values,
  inferred: Values,
  env: Readonly<Record<string, string | undefined>>,
  owner?: ValueOwner,
): Result<Values, ConfigError> {
  const resolved = new Map<string, string>(Object.entries(cached));
  for (const [placeholder, value] of Object.entries(inferred)) {
    if (!hasValue(resolved.get(placeholder))) {
      resolved.set(placeholder, value);
    }
  }

  const seen = new Set<string>();
  for (const rule of rules) {
    const placeholder = rule.placeholder;
    if (placeholder.length === 0 || seen.has(placeholder)) {
      continue;
    }
    seen.add(placeholder);
    if (hasValue(resolved.get(placeholder))) {
      continue;
    }
    const ruleDefault = rule.default;
    if (ruleDefault !== undefined && ruleDefault.length > 0) {
      resolved.set(placeholder, ruleDefault);
      continue;
    }
    const fromEnv =
      rule.defaultEnv === undefined ? undefined : env[rule.defaultEnv];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      resolved.set(placeholder, fromEnv);
      continue;
    }
    return missingValue(placeholder, owner);
  }

  return { ok: true, value: Object.fromEntries(resolved) };
}

/**
 * The first rule of each placeholder `resolveValues` would stop on: nothing
 * cached, inferred, given as the rule's `default` or as the environment
 * variable `defaultEnv` names. In rule order.
 */
export function missingPlaceholders(
  rules: readonly SanitizeRule[],
  cached: Values,
  inferred: Values,
  env: Readonly<Record<string, string | undefined>>,
): readonly SanitizeRule[] {
  const missing: SanitizeRule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const placeholder = rule.placeholder;
    if (placeholder.length === 0 || seen.has(placeholder)) {
      continue;
    }
    seen.add(placeholder);
    if (hasValue(cached[placeholder]) || hasValue(inferred[placeholder])) {
      continue;
    }
    if (hasValue(rule.default)) {
      continue;
    }
    const fromEnv =
      rule.defaultEnv === undefined ? undefined : env[rule.defaultEnv];
    if (hasValue(fromEnv)) {
      continue;
    }
    missing.push(rule);
  }
  return missing;
}

/** What an import prints before its first value question. */
export const ASK_HEADER =
  "\n  Enter values to fill the placeholders in the config files:\n\n";

/**
 * The interactive path of the bash engine's `request_values` with reset on and
 * direction import: every rule's placeholder is asked for in order, with any
 * cached value only as the default. `answers` stands in for the user's input;
 * an exhausted list answers with "". A missing answer falls back to the first
 * non-empty of the cached value, the rule's `default` and the environment
 * variable `defaultEnv` names, and stops with the `resolveValues` error when
 * that is empty too. The questions themselves are printed by the caller
 * (`importValueQuestions`).
 */
export function askValues(
  rules: readonly SanitizeRule[],
  cached: Values,
  env: Readonly<Record<string, string | undefined>>,
  answers: readonly string[],
  owner?: ValueOwner,
): Result<Values, ConfigError> {
  const values = new Map<string, string>(Object.entries(cached));
  const seen = new Set<string>();
  let index = 0;

  for (const rule of rules) {
    const placeholder = rule.placeholder;
    if (placeholder.length === 0 || seen.has(placeholder)) {
      continue;
    }
    seen.add(placeholder);

    const fromEnv =
      rule.defaultEnv === undefined ? undefined : env[rule.defaultEnv];
    const fallback = hasValue(cached[placeholder])
      ? cached[placeholder]
      : hasValue(rule.default)
        ? rule.default
        : hasValue(fromEnv)
          ? fromEnv
          : "";

    const raw = index < answers.length ? answers[index] : undefined;
    index++;
    const answer = trimAnswer(raw ?? "");
    const chosen = answer.length > 0 ? answer : fallback;
    if (chosen.length === 0) {
      return missingValue(placeholder, owner);
    }
    values.set(placeholder, chosen);
  }

  return { ok: true, value: Object.fromEntries(values) };
}

function firstMissingInContent(
  content: Uint8Array,
  rules: readonly SanitizeRule[],
  values: Values,
): string | undefined {
  const seen = new Set<string>();
  for (const rule of rules) {
    const placeholder = rule.placeholder;
    if (placeholder.length === 0 || seen.has(placeholder)) {
      continue;
    }
    seen.add(placeholder);
    if (hasValue(values[placeholder])) {
      continue;
    }
    if (indexOfBytes(content, encodeUtf8(placeholder), 0) !== -1) {
      return placeholder;
    }
  }
  return undefined;
}

function escapedPlaceholders(
  rules: readonly SanitizeRule[],
): ReadonlySet<string> {
  return new Set(
    rules
      .filter((rule) => rule.escapeBackslashes === true)
      .map((rule) => rule.placeholder),
  );
}

function replacementFor(
  placeholder: string,
  value: string,
  escaped: ReadonlySet<string>,
  options: HydrateOptions,
): string {
  if (options.json) {
    return jsonStringBody(value);
  }
  if (escaped.has(placeholder) && value.includes("\\")) {
    return value.replaceAll("\\", "\\\\");
  }
  return value;
}

/** Puts each placeholder's value back (contract "Hydrate (import)"). */
export function hydrate(
  content: Uint8Array,
  rules: readonly SanitizeRule[],
  values: Values,
  options: HydrateOptions,
): Result<Uint8Array, ConfigError> {
  const missing = firstMissingInContent(content, rules, values);
  if (missing !== undefined) {
    return missingValue(missing, options.owner);
  }

  const escaped = escapedPlaceholders(rules);
  const placeholders = placeholdersByLength(rules, values);
  let result = content;
  for (const [index, placeholder] of placeholders.entries()) {
    if (values[placeholder] === undefined) {
      continue;
    }
    result = replaceAllBytes(
      result,
      encodeUtf8(placeholder),
      placeholderToken(index),
    );
  }
  for (const [index, placeholder] of placeholders.entries()) {
    const value = values[placeholder];
    if (value === undefined) {
      continue;
    }
    const replacement = replacementFor(placeholder, value, escaped, options);
    result = replaceAllBytes(
      result,
      placeholderToken(index),
      encodeUtf8(replacement),
    );
  }
  return { ok: true, value: result };
}
