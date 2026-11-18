import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkV1V2 } from "../src/core/config/check.ts";
import { parseV1 } from "../src/core/config/v1.ts";
import { parseV2 } from "../src/core/config/v2.ts";
import { jsonEqual, parseJson } from "../src/core/json/value.ts";
import type { JsonValue } from "../src/core/json/value.ts";
import { mergeJson, parseJsonBytes } from "../src/core/merge/json.ts";
import {
  dropClaudeConfigRows,
  main,
  runLayout,
  splitClaudeSettings,
} from "./claude-layout.ts";

const FIXTURES = join(import.meta.dir, "fixtures/claude-layout");

const BASE = "dotfiles/common/claude/settings.json";
const LINUX = "dotfiles/linux/claude/settings.json";
const WINDOWS = "dotfiles/windows/claude/settings.json";
const V1 = "sync-config.json";
const V2 = "sync-config.v2.json";

const CLAUDE_SETTINGS_ENTRY = "claude/settings.json";
const CLAUDE_ROW_PATTERN =
  /^dotfiles\/[^/]+\/claude\/(?:settings\.json|statusline\.sh)$/;

const PERSONAL_ONLY_KEYS = [
  "enabledPlugins",
  "extraKnownMarketplaces",
  "permissions",
  "autoMode",
  "skipDangerousModePermissionPrompt",
];

const STATUS_LINE: JsonValue = {
  kind: "object",
  entries: new Map<string, JsonValue>([
    ["type", { kind: "string", value: "command" }],
    ["command", { kind: "string", value: "mksync statusline" }],
  ]),
};

const temporaryRepos: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryRepos.map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

/** A throwaway copy of the frozen repo files the tool reads. */
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "mksync-claude-layout-"));
  temporaryRepos.push(repo);
  await mkdir(join(repo, "dotfiles/linux/claude"), { recursive: true });
  for (const file of [LINUX, V1, V2]) {
    await copyFile(join(FIXTURES, file), join(repo, file));
  }
  return repo;
}

/** Every file under a folder, by repo-relative path, with its bytes. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, relative);
      } else {
        files[relative] = await readFile(path, "utf8");
      }
    }
  }
  await walk(root, "");
  return files;
}

/**
 * The v1 config text with each Claude row block dropped, derived from the
 * four-space row blocks alone rather than from the tool's span logic.
 */
function withoutClaudeRows(text: string): string {
  const kept: string[] = [];
  let block: string[] | undefined;
  for (const line of text.split("\n")) {
    if (block === undefined) {
      if (line === "    {") {
        block = [line];
      } else {
        kept.push(line);
      }
      continue;
    }
    block.push(line);
    if (line !== "    }," && line !== "    }") {
      continue;
    }
    const rowText = block.join("\n");
    const path =
      /"repoPath"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rowText)?.[1] ?? "";
    if (!CLAUDE_ROW_PATTERN.test(path)) {
      kept.push(...block);
    }
    block = undefined;
  }
  if (block !== undefined) {
    kept.push(...block);
  }
  return kept.join("\n");
}

function parseValue(text: string): JsonValue {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function objectEntries(value: JsonValue): ReadonlyMap<string, JsonValue> {
  if (value.kind !== "object") {
    throw new Error("expected a JSON object");
  }
  return value.entries;
}

function required(
  entries: ReadonlyMap<string, JsonValue>,
  key: string,
): JsonValue {
  const value = entries.get(key);
  if (value === undefined) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function entryItems(value: JsonValue): readonly JsonValue[] {
  const entries = required(objectEntries(value), "entries");
  if (entries.kind !== "array") {
    throw new Error("entries is not a list");
  }
  return entries.items;
}

function entryFileName(entry: JsonValue): string | undefined {
  const file = objectEntries(entry).get("file");
  return file?.kind === "string" ? file.value : undefined;
}

function v1Files(value: JsonValue): readonly JsonValue[] {
  const files = required(objectEntries(value), "files");
  if (files.kind !== "array") {
    throw new Error("files is not a list");
  }
  return files.items;
}

function v1RepoPath(row: JsonValue): string {
  const repoPath = objectEntries(row).get("repoPath");
  return repoPath?.kind === "string" ? repoPath.value : "";
}

function claudeSettingsEntry(
  config: JsonValue,
): ReadonlyMap<string, JsonValue> {
  for (const entry of entryItems(config)) {
    if (entryFileName(entry) === CLAUDE_SETTINGS_ENTRY) {
      return objectEntries(entry);
    }
  }
  throw new Error(`no ${CLAUDE_SETTINGS_ENTRY} entry`);
}

async function readJson(repo: string, file: string): Promise<JsonValue> {
  return parseValue(await readFile(join(repo, file), "utf8"));
}

describe("claude-layout", () => {
  test("the Linux layers merge back to today's settings, status line aside", async () => {
    const repo = await makeRepo();
    expect(await main([repo, "--cutover"])).toBe(0);

    const merged = mergeJson(
      [
        { repoPath: BASE, bytes: await readFile(join(repo, BASE)) },
        { repoPath: LINUX, bytes: await readFile(join(repo, LINUX)) },
      ],
      "\n",
    );
    if (!merged.ok) {
      throw new Error(merged.error);
    }
    const mergedValue = parseJsonBytes(merged.value);
    if (mergedValue === undefined) {
      throw new Error("the merged layers are not JSON");
    }

    const original = parseValue(await readFile(join(FIXTURES, LINUX), "utf8"));
    const expectedEntries = new Map(objectEntries(original));
    expectedEntries.set("statusLine", STATUS_LINE);

    expect(
      jsonEqual(mergedValue, { kind: "object", entries: expectedEntries }),
    ).toBe(true);
    expect(
      jsonEqual(
        required(objectEntries(mergedValue), "statusLine"),
        STATUS_LINE,
      ),
    ).toBe(true);
  });

  test("hooks are in the Linux overlay only", async () => {
    const repo = await makeRepo();
    expect((await runLayout(repo, { cutover: true })).ok).toBe(true);

    const linux = objectEntries(await readJson(repo, LINUX));
    const base = objectEntries(await readJson(repo, BASE));
    expect(linux.has("hooks")).toBe(true);
    expect(base.has("hooks")).toBe(false);
  });

  test("the personal-only keys are in the Linux overlay only", async () => {
    const repo = await makeRepo();
    expect((await runLayout(repo, { cutover: true })).ok).toBe(true);

    const source = objectEntries(await readJson(FIXTURES, LINUX));
    const linux = objectEntries(await readJson(repo, LINUX));
    const base = objectEntries(await readJson(repo, BASE));
    for (const key of PERSONAL_ONLY_KEYS) {
      expect(source.has(key)).toBe(true);
      expect(linux.has(key)).toBe(true);
      expect(base.has(key)).toBe(false);
    }
  });

  test("a source without the personal-only keys splits as before", async () => {
    const source = new Map(objectEntries(await readJson(FIXTURES, LINUX)));
    for (const key of PERSONAL_ONLY_KEYS) {
      source.delete(key);
    }

    const split = splitClaudeSettings({ kind: "object", entries: source }, []);

    if (!split.ok) {
      throw new Error(split.error);
    }
    const expectedBase = new Map(source);
    expectedBase.delete("hooks");
    expectedBase.set("statusLine", STATUS_LINE);
    expect(
      jsonEqual(split.value.base, { kind: "object", entries: expectedBase }),
    ).toBe(true);
    expect([...objectEntries(split.value.linux).keys()]).toEqual(["hooks"]);
    expect(split.value.windows).toBeUndefined();
  });

  test("an empty Linux key list keeps the personal-only keys in the base", async () => {
    const repo = await makeRepo();
    expect(
      (await runLayout(repo, { cutover: true, linuxOverlayKeys: [] })).ok,
    ).toBe(true);

    const linux = objectEntries(await readJson(repo, LINUX));
    const base = objectEntries(await readJson(repo, BASE));
    for (const key of PERSONAL_ONLY_KEYS) {
      expect(base.has(key)).toBe(true);
      expect(linux.has(key)).toBe(false);
    }
    expect([...linux.keys()]).toEqual(["hooks"]);
  });

  test("no Windows overlay while the key list is empty", async () => {
    const repo = await makeRepo();
    expect((await runLayout(repo, { cutover: true })).ok).toBe(true);
    expect(existsSync(join(repo, WINDOWS))).toBe(false);
  });

  test("a non-empty key list writes the Windows overlay", async () => {
    const repo = await makeRepo();
    const result = await runLayout(repo, {
      cutover: true,
      windowsOverlayKeys: ["theme", "tui"],
    });
    expect(result.ok).toBe(true);

    const source = objectEntries(await readJson(FIXTURES, LINUX));
    const windows = objectEntries(await readJson(repo, WINDOWS));
    expect(
      jsonEqual(required(windows, "theme"), required(source, "theme")),
    ).toBe(true);
    expect(jsonEqual(required(windows, "tui"), required(source, "tui"))).toBe(
      true,
    );
    expect(windows.size).toBe(2);
  });

  test("the v2 Claude settings entry lists windows", async () => {
    const repo = await makeRepo();
    const beforeText = await readFile(join(FIXTURES, V2), "utf8");
    expect((await runLayout(repo, { cutover: true })).ok).toBe(true);
    const afterText = await readFile(join(repo, V2), "utf8");

    const os = required(claudeSettingsEntry(parseValue(afterText)), "os");
    if (os.kind !== "array") {
      throw new Error("os is not a list");
    }
    const names = os.items.map((item) =>
      item.kind === "string" ? item.value : "",
    );
    expect(names).toContain("windows");
    expect(names).toContain("linux");

    const beforeItems = entryItems(parseValue(beforeText));
    const afterItems = entryItems(parseValue(afterText));
    expect(afterItems.length).toBe(beforeItems.length);
    for (const [index, entry] of afterItems.entries()) {
      const beforeEntry = beforeItems[index];
      if (beforeEntry === undefined) {
        throw new Error("the entry count changed");
      }
      if (entryFileName(entry) === CLAUDE_SETTINGS_ENTRY) {
        continue;
      }
      expect(jsonEqual(entry, beforeEntry)).toBe(true);
    }
  });

  test("without --cutover, main prints the planned writes and changes nothing", async () => {
    const repo = await makeRepo();
    const before = await snapshot(repo);
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    let code: number;
    try {
      code = await main([repo]);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(0);
    expect(lines).toEqual([
      `would write ${BASE}`,
      `would write ${LINUX}`,
      `would write ${V2}`,
      `would write ${V1}`,
    ]);
    expect(await snapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, BASE))).toBe(false);
  });

  test("v1 loses the Claude settings and statusline rows with --cutover", async () => {
    const repo = await makeRepo();
    expect(await main([repo, "--cutover"])).toBe(0);

    const beforeRows = v1Files(
      parseValue(await readFile(join(FIXTURES, V1), "utf8")),
    );
    const afterRows = v1Files(
      parseValue(await readFile(join(repo, V1), "utf8")),
    );
    const droppedRows = beforeRows.filter((row) =>
      CLAUDE_ROW_PATTERN.test(v1RepoPath(row)),
    );
    expect(droppedRows.length).toBe(2);
    const keptRows = beforeRows.filter(
      (row) => !CLAUDE_ROW_PATTERN.test(v1RepoPath(row)),
    );
    expect(
      jsonEqual(
        { kind: "array", items: afterRows },
        {
          kind: "array",
          items: keptRows,
        },
      ),
    ).toBe(true);
  });

  test("dropClaudeConfigRows drops the Claude rows and keeps every other byte", async () => {
    const input = await readFile(join(FIXTURES, V1), "utf8");
    const dropped = dropClaudeConfigRows(input);
    if (!dropped.ok) {
      throw new Error(dropped.error);
    }

    expect(dropped.value).not.toBe(input);
    expect(dropped.value).toBe(withoutClaudeRows(input));
  });

  test("the --cutover output keeps config v1 and v2 in step", async () => {
    const repo = await makeRepo();
    expect(await main([repo, "--cutover"])).toBe(0);

    const v1 = parseV1(await readFile(join(repo, V1), "utf8"));
    if (!v1.ok) {
      throw new Error(v1.error.message);
    }
    const v2 = parseV2(await readFile(join(repo, V2), "utf8"));
    if (!v2.ok) {
      throw new Error(v2.error.message);
    }

    expect(checkV1V2(v1.value, v2.value)).toEqual([]);
  });

  test("a second --cutover run is refused and changes nothing", async () => {
    const repo = await makeRepo();
    expect(await main([repo, "--cutover"])).toBe(0);
    const before = await snapshot(repo);

    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      },
    );
    let code: number;
    try {
      code = await main([repo, "--cutover"]);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(1);
    expect(errors).toEqual(["ERROR: the Claude layout is already split."]);
    expect(await snapshot(repo)).toEqual(before);
  });

  test("a write error follows the ERROR line and exits 1", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const repo = await makeRepo();
    const claudeDir = join(repo, "dotfiles/linux/claude");
    const linuxSettings = join(repo, LINUX);
    // The folder alone is not enough: the existing settings.json keeps its own
    // write bit, so writeFile could still truncate it.
    await chmod(linuxSettings, 0o444);
    await chmod(claudeDir, 0o555);

    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      },
    );
    let code: number;
    try {
      code = await main([repo, "--cutover"]);
    } finally {
      spy.mockRestore();
      await chmod(claudeDir, 0o755);
      await chmod(linuxSettings, 0o644);
    }

    expect(code).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]?.startsWith("ERROR: ")).toBe(true);
  });

  test("bad JSON exits 1 and writes nothing", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, LINUX), "{ not json\n", "utf8");
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      },
    );
    let code: number;
    try {
      code = await main([repo, "--cutover"]);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(1);
    expect(errors.some((line) => line.startsWith("ERROR: "))).toBe(true);
    expect(existsSync(join(repo, BASE))).toBe(false);
    expect(await readFile(join(repo, V2), "utf8")).toBe(
      await readFile(join(FIXTURES, V2), "utf8"),
    );
  });
});
