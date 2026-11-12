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

export interface HydrateOptions {
  readonly json: boolean;
}

function missingValueMessage(placeholder: string): string {
  return `missing value for ${placeholder}: add it to .user-values.json`;
}

function missingValue(placeholder: string): Result<never, ConfigError> {
  return {
    ok: false,
    error: { message: missingValueMessage(placeholder), code: 1 },
  };
}

function hasValue(value: string | undefined): boolean {
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
    content.length >= prefix.length &&
    indexOfBytes(content, prefix, 0) === 0
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
      const suffix = repoLine.subarray(repoPlaceholder + placeholderBytes.length);
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
    return missingValue(placeholder);
  }

  return { ok: true, value: Object.fromEntries(resolved) };
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

function escapedPlaceholders(rules: readonly SanitizeRule[]): ReadonlySet<string> {
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
    return missingValue(missing);
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
