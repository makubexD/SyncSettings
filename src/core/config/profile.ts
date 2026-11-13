import type { ConfigError, ConfigV2, Result } from "./types.ts";

/** A profile file: the modules one kind of machine gets, plus what's personal
 * to that job, per the design's "Modules and profiles". */
export interface Profile {
  readonly name: string;
  readonly modules: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly destinations: Readonly<Record<string, string>>;
  readonly retired: boolean;
}

const FIELDS: readonly string[] = [
  "modules",
  "values",
  "destinations",
  "retired",
];

const NOT_VALID_JSON = "not valid JSON";

/** The layer slots a new setting can go to. `base` and every other value is
 * refused: a destination only answers where a new setting goes. */
const DESTINATION_LAYERS: readonly string[] = ["os", "profile", "machine"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(name: string, reason: string): Result<Profile, ConfigError> {
  return {
    ok: false,
    error: { message: `ERROR: profile ${name}: ${reason}.`, code: 2 },
  };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => typeof item === "string")
    ? (value as readonly string[])
    : undefined;
}

function stringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return undefined;
    }
    entries.push([key, item]);
  }
  // Object.fromEntries makes each key an own data property, so a `__proto__`
  // key in the file stays plain data.
  return Object.fromEntries(entries);
}

/** Every destination must name one of the three writable slots; the reason
 * names the key, since `destinations has the wrong type` would hide which. */
function destinationRecord(
  value: unknown,
): Result<Readonly<Record<string, string>>, string> {
  if (!isRecord(value)) {
    return { ok: false, error: "destinations has the wrong type" };
  }
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || !DESTINATION_LAYERS.includes(item)) {
      return { ok: false, error: `destination ${key} is not a layer` };
    }
    entries.push([key, item]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

/**
 * Parses a profile file. All errors are exit code 2: the text isn't JSON or
 * isn't an object (`not valid JSON`), a top-level key other than the four
 * (`unknown field <f>`), a known field of the wrong type (`<f> has the wrong
 * type`), a module name config v2 doesn't know (`unknown module <m>`), and a
 * destination that isn't `os`, `profile` or `machine`
 * (`destination <key> is not a layer`).
 * Missing fields default to no modules, no values, no destinations and not
 * retired.
 */
export function parseProfile(
  name: string,
  text: string,
  config: ConfigV2,
): Result<Profile, ConfigError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(name, NOT_VALID_JSON);
  }
  if (!isRecord(parsed)) {
    return failure(name, NOT_VALID_JSON);
  }

  for (const key of Object.keys(parsed)) {
    if (!FIELDS.includes(key)) {
      return failure(name, `unknown field ${key}`);
    }
  }

  const modules =
    parsed.modules === undefined ? [] : stringList(parsed.modules);
  if (modules === undefined) {
    return failure(name, "modules has the wrong type");
  }

  const values =
    parsed.values === undefined ? {} : stringRecord(parsed.values);
  if (values === undefined) {
    return failure(name, "values has the wrong type");
  }

  const destinations =
    parsed.destinations === undefined
      ? { ok: true as const, value: {} }
      : destinationRecord(parsed.destinations);
  if (!destinations.ok) {
    return failure(name, destinations.error);
  }

  const retired = parsed.retired === undefined ? false : parsed.retired;
  if (typeof retired !== "boolean") {
    return failure(name, "retired has the wrong type");
  }

  for (const module of modules) {
    if (!Object.hasOwn(config.modules, module)) {
      return failure(name, `unknown module ${module}`);
    }
  }

  return {
    ok: true,
    value: {
      name,
      modules,
      values,
      destinations: destinations.value,
      retired,
    },
  };
}
