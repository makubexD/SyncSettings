import type { ConfigV2, Os, Result } from "../config/types.ts";
import type { JsonValue } from "../json/value.ts";
import { writeJson } from "../json/value.ts";
import { LAYER_NAME, RESERVED_LAYER_NAMES } from "../layers/names.ts";

/** The second setup question's answer. */
export type ClaudeMode = "none" | "claude" | "claude-deepseek";

/** One takeover of another machine, `replaced` oldest first. */
export interface ReplacedMachine {
  readonly hostname: string;
  readonly domain: string | null;
  readonly date: string;
}

/** A machine record: who this machine is and what belongs to it alone, per
 * the design's "Machine records". */
export interface MachineRecord {
  readonly name: string;
  readonly profile: string;
  readonly os: Os;
  readonly hostname: string;
  readonly domain: string | null;
  readonly claude: ClaudeMode;
  readonly pullOnly: boolean;
  readonly modules: {
    readonly add: readonly string[];
    readonly remove: readonly string[];
  };
  readonly values: Readonly<Record<string, string>>;
  readonly replaced: readonly ReplacedMachine[];
  readonly retired: boolean;
}

const FIELDS: readonly string[] = [
  "name",
  "profile",
  "os",
  "hostname",
  "domain",
  "claude",
  "pullOnly",
  "modules",
  "values",
  "replaced",
  "retired",
];

const MODULE_FIELDS: readonly string[] = ["add", "remove"];

const REPLACED_FIELDS: readonly string[] = ["hostname", "domain", "date"];

const OSES: readonly string[] = ["linux", "macos", "windows"];

const CLAUDE_MODES: readonly string[] = ["none", "claude", "claude-deepseek"];

const NOT_VALID_JSON = "not valid JSON";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOs(value: string): value is Os {
  return OSES.includes(value);
}

function isClaudeMode(value: string): value is ClaudeMode {
  return CLAUDE_MODES.includes(value);
}

function failure(reason: string): Result<MachineRecord, string> {
  return { ok: false, error: reason };
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

/** One name check: the pattern, then a name another layer already uses. */
function nameReason(field: string, value: string): string | undefined {
  if (!LAYER_NAME.test(value)) {
    return `${field} must be lowercase letters, digits and -; this is ${value}`;
  }
  if (RESERVED_LAYER_NAMES.includes(value)) {
    return `${field} can't be ${value}: it names another layer`;
  }
  return undefined;
}

function readModules(value: unknown): Result<MachineRecord["modules"], string> {
  if (!isRecord(value)) {
    return { ok: false, error: "modules has the wrong type" };
  }
  for (const key of Object.keys(value)) {
    if (!MODULE_FIELDS.includes(key)) {
      return { ok: false, error: `unknown field ${key}` };
    }
  }
  for (const field of MODULE_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      return { ok: false, error: `missing field ${field}` };
    }
  }
  const add = stringList(value.add);
  const remove = stringList(value.remove);
  if (add === undefined || remove === undefined) {
    return { ok: false, error: "modules has the wrong type" };
  }
  return { ok: true, value: { add, remove } };
}

function readReplaced(value: unknown): readonly ReplacedMachine[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: ReplacedMachine[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }
    const keys = Object.keys(item);
    if (keys.length !== REPLACED_FIELDS.length) {
      return undefined;
    }
    const { hostname, domain, date } = item;
    if (typeof hostname !== "string") {
      return undefined;
    }
    if (domain !== null && typeof domain !== "string") {
      return undefined;
    }
    if (typeof date !== "string" || !DATE_RE.test(date)) {
      return undefined;
    }
    items.push({ hostname, domain, date });
  }
  return items;
}

/**
 * Parses the full record form. Every field is required and no other is
 * allowed. The error is the contract's reason without its `ERROR:` line:
 * `not valid JSON`, `unknown field <f>`, `missing field <f>`,
 * `<f> has the wrong type`, `<f> must be lowercase letters, digits and -;
 * this is <value>`, `<f> can't be <value>: it names another layer`,
 * `<f> can't be <value>` for an `os` or `claude` outside its list, or
 * `unknown module <m>`. The `{"name", "home": "repo"}` pointer form is read
 * elsewhere.
 */
export function parseRecord(
  text: string,
  config: ConfigV2,
): Result<MachineRecord, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(NOT_VALID_JSON);
  }
  if (!isRecord(parsed)) {
    return failure(NOT_VALID_JSON);
  }

  for (const key of Object.keys(parsed)) {
    if (!FIELDS.includes(key)) {
      return failure(`unknown field ${key}`);
    }
  }
  for (const field of FIELDS) {
    if (!Object.hasOwn(parsed, field)) {
      return failure(`missing field ${field}`);
    }
  }

  const name = parsed.name;
  if (typeof name !== "string") {
    return failure("name has the wrong type");
  }
  const nameProblem = nameReason("name", name);
  if (nameProblem !== undefined) {
    return failure(nameProblem);
  }

  const profile = parsed.profile;
  if (typeof profile !== "string") {
    return failure("profile has the wrong type");
  }
  const profileProblem = nameReason("profile", profile);
  if (profileProblem !== undefined) {
    return failure(profileProblem);
  }
  // shortcut: the contract gives no reason for a name equal to its profile;
  // this follows its `<f> can't be <value>` form.
  if (name === profile) {
    return failure(`name can't be ${name}`);
  }

  const os = parsed.os;
  if (typeof os !== "string") {
    return failure("os has the wrong type");
  }
  if (!isOs(os)) {
    return failure(`os can't be ${os}`);
  }

  const hostname = parsed.hostname;
  if (typeof hostname !== "string") {
    return failure("hostname has the wrong type");
  }

  const domain = parsed.domain;
  if (domain !== null && typeof domain !== "string") {
    return failure("domain has the wrong type");
  }

  const claude = parsed.claude;
  if (typeof claude !== "string") {
    return failure("claude has the wrong type");
  }
  if (!isClaudeMode(claude)) {
    return failure(`claude can't be ${claude}`);
  }

  const pullOnly = parsed.pullOnly;
  if (typeof pullOnly !== "boolean") {
    return failure("pullOnly has the wrong type");
  }

  const modules = readModules(parsed.modules);
  if (!modules.ok) {
    return failure(modules.error);
  }
  for (const module of [...modules.value.add, ...modules.value.remove]) {
    if (!Object.hasOwn(config.modules, module)) {
      return failure(`unknown module ${module}`);
    }
  }

  const values = stringRecord(parsed.values);
  if (values === undefined) {
    return failure("values has the wrong type");
  }

  const replaced = readReplaced(parsed.replaced);
  if (replaced === undefined) {
    return failure("replaced has the wrong type");
  }

  const retired = parsed.retired;
  if (typeof retired !== "boolean") {
    return failure("retired has the wrong type");
  }

  return {
    ok: true,
    value: {
      name,
      profile,
      os,
      hostname,
      domain,
      claude,
      pullOnly,
      modules: modules.value,
      values,
      replaced,
      retired,
    },
  };
}

/** The contract's one line for a bad record; `reason` comes from parseRecord. */
export function recordMessage(reason: string): string {
  return `ERROR: machine record (machine.json in the state folder): ${reason}.`;
}

function jsonString(value: string): JsonValue {
  return { kind: "string", value };
}

function jsonStrings(values: readonly string[]): JsonValue {
  return { kind: "array", items: values.map(jsonString) };
}

function replacedValue(item: ReplacedMachine): JsonValue {
  const domain: JsonValue =
    item.domain === null ? { kind: "null" } : jsonString(item.domain);
  return {
    kind: "object",
    entries: new Map<string, JsonValue>([
      ["hostname", jsonString(item.hostname)],
      ["domain", domain],
      ["date", jsonString(item.date)],
    ]),
  };
}

function recordValue(record: MachineRecord): JsonValue {
  const values: [string, JsonValue][] = Object.entries(record.values).map(
    ([key, value]) => [key, jsonString(value)],
  );
  return {
    kind: "object",
    entries: new Map<string, JsonValue>([
      ["name", jsonString(record.name)],
      ["profile", jsonString(record.profile)],
      ["os", jsonString(record.os)],
      ["hostname", jsonString(record.hostname)],
      [
        "domain",
        record.domain === null ? { kind: "null" } : jsonString(record.domain),
      ],
      ["claude", jsonString(record.claude)],
      ["pullOnly", { kind: "bool", value: record.pullOnly }],
      [
        "modules",
        {
          kind: "object",
          entries: new Map<string, JsonValue>([
            ["add", jsonStrings(record.modules.add)],
            ["remove", jsonStrings(record.modules.remove)],
          ]),
        },
      ],
      ["values", { kind: "object", entries: new Map(values) }],
      [
        "replaced",
        { kind: "array", items: record.replaced.map(replacedValue) },
      ],
      ["retired", { kind: "bool", value: record.retired }],
    ]),
  };
}

/**
 * The record as the contract writes it: the key order above, two-space
 * indent, one key or item per line, `{}` and `[]` when empty, LF and a
 * trailing newline. The `json` entry layout does the writing.
 */
export function recordText(record: MachineRecord): string {
  return writeJson(recordValue(record), "\n");
}
