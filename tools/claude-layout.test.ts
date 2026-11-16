import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonEqual, parseJson } from "../src/core/json/value.ts";
import type { JsonValue } from "../src/core/json/value.ts";
import { mergeJson, parseJsonBytes } from "../src/core/merge/json.ts";
import { main, runLayout } from "./claude-layout.ts";

const REPO = join(import.meta.dir, "..");

const BASE = "dotfiles/common/claude/settings.json";
const LINUX = "dotfiles/linux/claude/settings.json";
const WINDOWS = "dotfiles/windows/claude/settings.json";
const V1 = "sync-config.json";
const V2 = "sync-config.v2.json";

const CLAUDE_SETTINGS_ENTRY = "claude/settings.json";
const CLAUDE_ROW_PATTERN =
  /^dotfiles\/[^/]+\/claude\/(?:settings\.json|statusline\.sh)$/;

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

/** A throwaway copy of the repo files the tool reads. */
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "mksync-claude-layout-"));
  temporaryRepos.push(repo);
  await mkdir(join(repo, "dotfiles/linux/claude"), { recursive: true });
  for (const file of [LINUX, V1, V2]) {
    await copyFile(join(REPO, file), join(repo, file));
  }
  return repo;
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
    expect(await main([repo])).toBe(0);

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

    const original = parseValue(await readFile(join(REPO, LINUX), "utf8"));
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
    expect((await runLayout(repo)).ok).toBe(true);

    const linux = objectEntries(await readJson(repo, LINUX));
    const base = objectEntries(await readJson(repo, BASE));
    expect(linux.has("hooks")).toBe(true);
    expect(base.has("hooks")).toBe(false);
  });

  test("no Windows overlay while the key list is empty", async () => {
    const repo = await makeRepo();
    expect((await runLayout(repo)).ok).toBe(true);
    expect(existsSync(join(repo, WINDOWS))).toBe(false);
  });

  test("a non-empty key list writes the Windows overlay", async () => {
    const repo = await makeRepo();
    const result = await runLayout(repo, {
      windowsOverlayKeys: ["theme", "tui"],
    });
    expect(result.ok).toBe(true);

    const source = objectEntries(await readJson(REPO, LINUX));
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
    const beforeText = await readFile(join(REPO, V2), "utf8");
    expect((await runLayout(repo)).ok).toBe(true);
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

  test("v1 stays untouched without --cutover", async () => {
    const repo = await makeRepo();
    expect(await main([repo])).toBe(0);
    expect(await readFile(join(repo, V1), "utf8")).toBe(
      await readFile(join(REPO, V1), "utf8"),
    );
  });

  test("v1 loses the Claude settings and statusline rows with --cutover", async () => {
    const repo = await makeRepo();
    expect(await main([repo, "--cutover"])).toBe(0);

    const beforeRows = v1Files(
      parseValue(await readFile(join(REPO, V1), "utf8")),
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
      code = await main([repo]);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(1);
    expect(errors.some((line) => line.startsWith("ERROR: "))).toBe(true);
    expect(existsSync(join(repo, BASE))).toBe(false);
    expect(await readFile(join(repo, V2), "utf8")).toBe(
      await readFile(join(REPO, V2), "utf8"),
    );
  });
});
