// Dev-only: plans the layered Claude settings of the design's "The Claude
// layout waits for cut-over", widens the v2 row to Windows, and drops the v1
// Claude rows. Without --cutover it prints the planned writes and changes
// nothing; with it, it writes them. It refuses a repo that already has the
// split base file. Never compiled into the program, and not run against the
// real repo before phase 9.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Result } from "../src/core/config/types.ts";
import { parseJson, writeJson } from "../src/core/json/value.ts";
import type { JsonValue } from "../src/core/json/value.ts";

const LF = "\n";

const BASE_SETTINGS_FILE = "dotfiles/common/claude/settings.json";
const LINUX_SETTINGS_FILE = "dotfiles/linux/claude/settings.json";
const WINDOWS_SETTINGS_FILE = "dotfiles/windows/claude/settings.json";
const V1_CONFIG_FILE = "sync-config.json";
const V2_CONFIG_FILE = "sync-config.v2.json";

const CLAUDE_SETTINGS_ENTRY = "claude/settings.json";
const STATUS_LINE_KEY = "statusLine";
const STATUSLINE_COMMAND = "mksync statusline";
const WINDOWS = "windows";

/** Top-level keys the Linux overlay keeps whatever their value holds. */
const LINUX_ONLY_KEYS: readonly string[] = ["hooks"];

const HOME_MARKER = "<HOME>";
const SHELL_SUFFIX = ".sh";

/** The v1 rows a split settings.json and `mksync statusline` replace. */
const CLAUDE_ROW_PATTERN =
  /^dotfiles\/[^/]+\/claude\/(?:settings\.json|statusline\.sh)$/;

// shortcut: empty until the Windows survey (step 27) names the keys the work
// machines need; while it is empty the tool writes no Windows overlay.
export const WINDOWS_OVERLAY_KEYS: readonly string[] = [];

export interface LayoutOptions {
  readonly cutover?: boolean;
  /** The Windows overlay's keys; WINDOWS_OVERLAY_KEYS when absent. */
  readonly windowsOverlayKeys?: readonly string[];
}

/** The three layers one source `settings.json` splits into. */
export interface ClaudeLayout {
  readonly base: JsonValue;
  readonly linux: JsonValue;
  /** Undefined when the Windows overlay takes no keys. */
  readonly windows: JsonValue | undefined;
}

export interface LayoutWrite {
  readonly repoPath: string;
  readonly text: string;
}

function err<T>(message: string): Result<T, string> {
  return { ok: false, error: message };
}

function stringValue(value: string): JsonValue {
  return { kind: "string", value };
}

function objectValue(entries: ReadonlyMap<string, JsonValue>): JsonValue {
  return { kind: "object", entries };
}

function statusLineValue(): JsonValue {
  return objectValue(
    new Map<string, JsonValue>([
      ["type", stringValue("command")],
      ["command", stringValue(STATUSLINE_COMMAND)],
    ]),
  );
}

/**
 * Whether a value holds `<HOME>` or a `.sh` path at any depth: the rule that
 * keeps a key in the Linux overlay.
 */
export function holdsMachinePath(value: JsonValue): boolean {
  switch (value.kind) {
    case "string":
      return (
        value.value.includes(HOME_MARKER) ||
        value.value.split(/\s+/).some((part) => part.endsWith(SHELL_SUFFIX))
      );
    case "array":
      return value.items.some(holdsMachinePath);
    case "object":
      return [...value.entries.values()].some(holdsMachinePath);
    case "null":
    case "bool":
    case "number":
      return false;
  }
}

/**
 * Splits one machine-independent `settings.json` into the base layer (every
 * key but the Linux-only ones, its `statusLine` set to `mksync statusline`), the
 * Linux overlay (`hooks` and the machine-path keys) and, when `windowsOverlayKeys`
 * is not empty, the Windows overlay holding those keys as the source has them.
 * Source key order is kept; `statusLine` keeps its place, or ends the base when
 * the source has none.
 */
export function splitClaudeSettings(
  source: JsonValue,
  windowsOverlayKeys: readonly string[],
): Result<ClaudeLayout, string> {
  if (source.kind !== "object") {
    return err(`${LINUX_SETTINGS_FILE} is not a JSON object`);
  }
  const baseEntries = new Map<string, JsonValue>();
  const linuxEntries = new Map<string, JsonValue>();
  let hasStatusLine = false;
  for (const [key, value] of source.entries) {
    if (key === STATUS_LINE_KEY) {
      baseEntries.set(key, statusLineValue());
      hasStatusLine = true;
    } else if (LINUX_ONLY_KEYS.includes(key) || holdsMachinePath(value)) {
      linuxEntries.set(key, value);
    } else {
      baseEntries.set(key, value);
    }
  }
  if (!hasStatusLine) {
    baseEntries.set(STATUS_LINE_KEY, statusLineValue());
  }

  let windows: JsonValue | undefined;
  if (windowsOverlayKeys.length > 0) {
    for (const key of windowsOverlayKeys) {
      if (!source.entries.has(key)) {
        return err(
          `${LINUX_SETTINGS_FILE} has no "${key}" for the Windows overlay`,
        );
      }
    }
    const windowsKeys = new Set(windowsOverlayKeys);
    const windowsEntries = new Map<string, JsonValue>();
    for (const [key, value] of source.entries) {
      if (windowsKeys.has(key)) {
        windowsEntries.set(key, value);
      }
    }
    windows = objectValue(windowsEntries);
  }

  return {
    ok: true,
    value: {
      base: objectValue(baseEntries),
      linux: objectValue(linuxEntries),
      windows,
    },
  };
}

function entryFile(entry: JsonValue): string | undefined {
  if (entry.kind !== "object") {
    return undefined;
  }
  const file = entry.entries.get("file");
  return file?.kind === "string" ? file.value : undefined;
}

function withWindowsOs(entry: JsonValue): Result<JsonValue, string> {
  if (entry.kind !== "object") {
    return err(`${V2_CONFIG_FILE}: an entry is not a JSON object`);
  }
  const os = entry.entries.get("os");
  if (os === undefined) {
    // Without an `os` list the entry already runs on every OS.
    return { ok: true, value: entry };
  }
  if (os.kind !== "array") {
    return err(
      `"os" of ${CLAUDE_SETTINGS_ENTRY} is not a list in ${V2_CONFIG_FILE}`,
    );
  }
  if (
    os.items.some((item) => item.kind === "string" && item.value === WINDOWS)
  ) {
    return { ok: true, value: entry };
  }
  const entries = new Map(entry.entries);
  entries.set("os", {
    kind: "array",
    items: [...os.items, stringValue(WINDOWS)],
  });
  return { ok: true, value: objectValue(entries) };
}

/**
 * Widens the `os` list of the `claude/settings.json` entry in config v2 to
 * `windows`, leaving every other entry as it was.
 */
export function widenClaudeSettingsOs(
  config: JsonValue,
): Result<JsonValue, string> {
  if (config.kind !== "object") {
    return err(`${V2_CONFIG_FILE} is not a JSON object`);
  }
  const entries = config.entries.get("entries");
  if (entries === undefined || entries.kind !== "array") {
    return err(`${V2_CONFIG_FILE} has no entries list`);
  }
  const items: JsonValue[] = [];
  let found = false;
  for (const entry of entries.items) {
    if (entryFile(entry) !== CLAUDE_SETTINGS_ENTRY) {
      items.push(entry);
      continue;
    }
    const widened = withWindowsOs(entry);
    if (!widened.ok) {
      return widened;
    }
    found = true;
    items.push(widened.value);
  }
  if (!found) {
    return err(`${V2_CONFIG_FILE} has no ${CLAUDE_SETTINGS_ENTRY} entry`);
  }
  const next = new Map(config.entries);
  next.set("entries", { kind: "array", items });
  return { ok: true, value: objectValue(next) };
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Every `{…}` object in the text, string literals skipped. */
function objectSpans(text: string): readonly Span[] {
  const spans: Span[] = [];
  const open: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      open.push(index);
    } else if (char === "}") {
      const start = open.pop();
      if (start !== undefined) {
        spans.push({ start, end: index });
      }
    }
  }
  return spans;
}

function innermostSpan(
  spans: readonly Span[],
  index: number,
): Span | undefined {
  let found: Span | undefined;
  for (const span of spans) {
    if (
      span.start < index &&
      index < span.end &&
      (found === undefined || span.start > found.start)
    ) {
      found = span;
    }
  }
  return found;
}

/** The object of every v1 row whose `repoPath` is a Claude settings row. */
function claudeRowSpans(text: string): readonly Span[] {
  const spans = objectSpans(text);
  const rows: Span[] = [];
  const pattern = /"repoPath"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1];
    if (path === undefined || !CLAUDE_ROW_PATTERN.test(path)) {
      continue;
    }
    const span = innermostSpan(spans, match.index ?? 0);
    if (span !== undefined && !rows.some((row) => row.start === span.start)) {
      rows.push(span);
    }
  }
  return rows;
}

function skipSpaces(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char !== " " && char !== "\t") {
      break;
    }
    index += 1;
  }
  return index;
}

/** Removes one object with the comma that follows it, else the one before. */
function removeObject(text: string, span: Span): string {
  let start = text.lastIndexOf("\n", span.start) + 1;
  let end = span.end + 1;
  let cursor = skipSpaces(text, end);
  if (text.charAt(cursor) === ",") {
    end = cursor + 1;
    if (text.charAt(end) === "\r") {
      end += 1;
    }
    if (text.charAt(end) === "\n") {
      end += 1;
    }
  } else {
    let before = start - 1;
    while (before >= 0 && /\s/.test(text.charAt(before))) {
      before -= 1;
    }
    if (text.charAt(before) === ",") {
      start = before;
    }
    cursor = skipSpaces(text, span.end + 1);
    if (text.charAt(cursor) === "\r") {
      cursor += 1;
    }
    if (text.charAt(cursor) === "\n") {
      cursor += 1;
    }
    end = cursor;
  }
  return text.slice(0, start) + text.slice(end);
}

/**
 * Drops the v1 rows whose `repoPath` is a Claude `settings.json` or
 * `statusline.sh`, keeping every other byte of the file.
 */
export function dropClaudeConfigRows(text: string): Result<string, string> {
  const spans = claudeRowSpans(text);
  if (spans.length === 0) {
    return { ok: true, value: text };
  }
  let dropped = text;
  for (const span of [...spans].sort(
    (left, right) => right.start - left.start,
  )) {
    dropped = removeObject(dropped, span);
  }
  const parsed = parseJson(dropped);
  if (!parsed.ok) {
    return err(
      `dropping the Claude rows left ${V1_CONFIG_FILE} invalid: ${parsed.error}`,
    );
  }
  return { ok: true, value: dropped };
}

async function readText(
  repoDir: string,
  repoPath: string,
): Promise<Result<string, string>> {
  try {
    return { ok: true, value: await readFile(join(repoDir, repoPath), "utf8") };
  } catch {
    return err(`cannot read ${repoPath}`);
  }
}

function parseObjectText(
  text: string,
  repoPath: string,
): Result<JsonValue, string> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return err(`${repoPath} is not valid JSON`);
  }
  if (parsed.value.kind !== "object") {
    return err(`${repoPath} is not a JSON object`);
  }
  return parsed;
}

async function writeAll(
  repoDir: string,
  writes: readonly LayoutWrite[],
): Promise<void> {
  for (const write of writes) {
    const path = join(repoDir, write.repoPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, write.text, "utf8");
  }
}

/**
 * Plans the layout on a repo folder: the base and Linux layers, the Windows
 * overlay when its key list is not empty, the v2 row widened to Windows and
 * the v1 Claude rows dropped. Refuses a repo that already has the split base
 * file. Returns the planned writes in plan order; `cutover` writes them, and
 * without it nothing is written. No plan is made unless every file it needs
 * reads and parses.
 */
export async function runLayout(
  repoDir: string,
  options: LayoutOptions = {},
): Promise<Result<readonly LayoutWrite[], string>> {
  if (existsSync(join(repoDir, BASE_SETTINGS_FILE))) {
    return err("the Claude layout is already split.");
  }
  const sourceText = await readText(repoDir, LINUX_SETTINGS_FILE);
  if (!sourceText.ok) {
    return sourceText;
  }
  const source = parseObjectText(sourceText.value, LINUX_SETTINGS_FILE);
  if (!source.ok) {
    return source;
  }
  const split = splitClaudeSettings(
    source.value,
    options.windowsOverlayKeys ?? WINDOWS_OVERLAY_KEYS,
  );
  if (!split.ok) {
    return split;
  }

  const configText = await readText(repoDir, V2_CONFIG_FILE);
  if (!configText.ok) {
    return configText;
  }
  const config = parseObjectText(configText.value, V2_CONFIG_FILE);
  if (!config.ok) {
    return config;
  }
  const widened = widenClaudeSettingsOs(config.value);
  if (!widened.ok) {
    return widened;
  }

  const writes: LayoutWrite[] = [
    { repoPath: BASE_SETTINGS_FILE, text: writeJson(split.value.base, LF) },
    { repoPath: LINUX_SETTINGS_FILE, text: writeJson(split.value.linux, LF) },
  ];
  if (split.value.windows !== undefined) {
    writes.push({
      repoPath: WINDOWS_SETTINGS_FILE,
      text: writeJson(split.value.windows, LF),
    });
  }
  const widenedText = writeJson(widened.value, LF);
  if (widenedText !== configText.value) {
    writes.push({ repoPath: V2_CONFIG_FILE, text: widenedText });
  }

  const v1Text = await readText(repoDir, V1_CONFIG_FILE);
  if (!v1Text.ok) {
    return v1Text;
  }
  const dropped = dropClaudeConfigRows(v1Text.value);
  if (!dropped.ok) {
    return dropped;
  }
  if (dropped.value !== v1Text.value) {
    writes.push({ repoPath: V1_CONFIG_FILE, text: dropped.value });
  }

  if (options.cutover === true) {
    try {
      await writeAll(repoDir, writes);
    } catch (error) {
      if (error instanceof Error) {
        return err(error.message);
      }
      throw error;
    }
  }
  return { ok: true, value: writes };
}

const USAGE = "bun tools/claude-layout.ts <repo folder> [--cutover]";

/** argv in, its errors printed, its exit code out. */
export async function main(argv: readonly string[]): Promise<number> {
  let repoDir: string | undefined;
  let cutover = false;
  for (const arg of argv) {
    if (arg === "--cutover") {
      cutover = true;
    } else if (arg.startsWith("-")) {
      console.error(`ERROR: unknown option ${arg}\nusage: ${USAGE}`);
      return 1;
    } else if (repoDir === undefined) {
      repoDir = arg;
    } else {
      console.error(`ERROR: unexpected argument ${arg}\nusage: ${USAGE}`);
      return 1;
    }
  }
  if (repoDir === undefined) {
    console.error(`usage: ${USAGE}`);
    return 1;
  }
  const result = await runLayout(repoDir, { cutover });
  if (!result.ok) {
    console.error(`ERROR: ${result.error}`);
    return 1;
  }
  if (!cutover) {
    for (const write of result.value) {
      console.log(`would write ${write.repoPath}`);
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
