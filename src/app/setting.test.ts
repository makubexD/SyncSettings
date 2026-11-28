import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadLayers } from "../adapters/snapshot.ts";
import type { SettingMoveCommand } from "../cli/parse.ts";
import { parseV2 } from "../core/config/v2.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import { runSettingMove } from "./setting.ts";
import type { SettingListInput, SettingMoveDeps } from "./setting.ts";

const CONFIG_TEXT = JSON.stringify({
  schemaVersion: 2,
  modules: { vscode: { description: "VS Code" } },
  entries: [
    {
      file: "vscode/settings.json",
      module: "vscode",
      merge: "json",
      localPath: "~/.config/Code/User/settings.json",
      description: "VS Code settings",
    },
  ],
});

const RECORD = {
  name: "wk1-laptop",
  profile: "work1",
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
  claude: "claude",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const PROFILE = {
  modules: ["vscode"],
  values: {},
  destinations: {},
  retired: false,
};

const BASE_FILE = "dotfiles/common/vscode/settings.json";
const PROFILE_FILE = "profiles/work1/vscode/settings.json";
const BASE_TEXT = '{\n  "editor.fontSize": 14\n}\n';
const PROFILE_TEXT = '{\n  "editor.fontSize": 15\n}\n';
const MOVED_BASE_TEXT = '{\n  "editor.fontSize": 15\n}\n';

const PREVIEW = [
  "Move vscode settings.json editor.fontSize: 15",
  "  from profile work1 to all machines",
  `MODIFIED ${BASE_FILE}`,
  `MODIFIED ${PROFILE_FILE}`,
].join("\n");

const QUESTION = "Move it? [y/N] ";
const FIXED_NOW = new Date("2026-11-27T10:00:00Z");

const MOVE: SettingMoveCommand = {
  kind: "setting-move",
  file: "vscode/settings.json",
  key: "editor.fontSize",
  to: "base",
  dryRun: false,
  yes: false,
};

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly state: string;
  readonly input: SettingListInput;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function config(): ConfigV2 {
  const parsed = parseV2(CONFIG_TEXT);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mksync-setting-test-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const state = join(home, ".local/state/sync-settings");
  writeText(join(repo, "sync-config.json"), CONFIG_TEXT);
  writeText(join(repo, BASE_FILE), BASE_TEXT);
  writeText(join(state, "machine.json"), JSON.stringify(RECORD));
  writeText(join(state, "profiles/work1.json"), JSON.stringify(PROFILE));
  writeText(join(state, PROFILE_FILE), PROFILE_TEXT);
  const layers = loadLayers(state, repo, config());
  if (!layers.ok) {
    throw new Error(layers.error.message);
  }
  return {
    root,
    repo,
    state,
    input: {
      repoRoot: repo,
      config: config(),
      os: "linux",
      home,
      state,
      layers: layers.value,
    },
  };
}

interface Asked {
  readonly texts: string[];
}

function makeDeps(
  answer: string | undefined,
  terminal: boolean,
  asked: Asked,
): SettingMoveDeps {
  return {
    terminal: () => terminal,
    ask: async (text) => {
      asked.texts.push(text);
      return answer;
    },
    clean: async () => true,
    scan: async () => ({ kind: "clean", code: 0, stdout: "", stderr: "" }),
    now: () => FIXED_NOW,
  };
}

function readRepo(fixture: Fixture, path: string): string {
  return readFileSync(join(fixture.repo, path), "utf8");
}

describe("runSettingMove", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("should print Nothing moved. and write nothing when the answer is no", async () => {
    // Arrange
    const asked: Asked = { texts: [] };

    // Act
    const result = await runSettingMove(
      MOVE,
      fixture.input,
      makeDeps("n", true, asked),
    );

    // Assert
    expect(result).toEqual({ code: 1, stdout: "Nothing moved.\n", stderr: "" });
    expect(asked.texts).toEqual([`${PREVIEW}\n${QUESTION}`]);
    expect(readRepo(fixture, BASE_FILE)).toBe(BASE_TEXT);
  });

  test("should decline at end of input", async () => {
    // Arrange
    const asked: Asked = { texts: [] };

    // Act
    const result = await runSettingMove(
      MOVE,
      fixture.input,
      makeDeps(undefined, true, asked),
    );

    // Assert
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("Nothing moved.\n");
  });

  test("should write the move after a yes, with the push line", async () => {
    // Arrange
    const asked: Asked = { texts: [] };

    // Act
    const result = await runSettingMove(
      MOVE,
      fixture.input,
      makeDeps("y", true, asked),
    );

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: "Moved. mksync push sends it to the other machines.\n",
      stderr: "",
    });
    expect(readRepo(fixture, BASE_FILE)).toBe(MOVED_BASE_TEXT);
  });

  test("should refuse after a yes when the file changed while the question waited", async () => {
    // Arrange
    const asked: Asked = { texts: [] };
    let answered = false;
    const deps: SettingMoveDeps = {
      ...makeDeps("y", true, asked),
      ask: async (text) => {
        asked.texts.push(text);
        answered = true;
        return "y";
      },
      clean: async () => !answered,
    };

    // Act
    const result = await runSettingMove(MOVE, fixture.input, deps);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `refused: ${BASE_FILE} has changes that aren't sent; run mksync push first.\n`,
    );
    expect(readRepo(fixture, BASE_FILE)).toBe(BASE_TEXT);
  });

  test("should print the preview and write nothing under --dry-run", async () => {
    // Arrange
    const asked: Asked = { texts: [] };

    // Act
    const result = await runSettingMove(
      { ...MOVE, dryRun: true },
      fixture.input,
      makeDeps(undefined, false, asked),
    );

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: `${PREVIEW}\nNothing written (--dry-run).\n`,
      stderr: "",
    });
    expect(asked.texts).toEqual([]);
    expect(readRepo(fixture, BASE_FILE)).toBe(BASE_TEXT);
  });

  test("should write without asking under --yes and keep the state file's .bak", async () => {
    // Arrange
    const asked: Asked = { texts: [] };

    // Act
    const result = await runSettingMove(
      { ...MOVE, yes: true },
      fixture.input,
      makeDeps(undefined, false, asked),
    );

    // Assert
    expect(result.stdout).toBe(
      `${PREVIEW}\nMoved. mksync push sends it to the other machines.\n`,
    );
    expect(asked.texts).toEqual([]);
    expect(
      readFileSync(join(fixture.state, `${PROFILE_FILE}.bak`), "utf8"),
    ).toBe(PROFILE_TEXT);
  });

  test("should stop with exit 2 when there is no terminal and no --yes", async () => {
    // Arrange
    const asked: Asked = { texts: [] };

    // Act
    const result = await runSettingMove(
      MOVE,
      fixture.input,
      makeDeps("y", false, asked),
    );

    // Assert
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "ERROR: setting move needs a terminal or --yes\n",
    });
    expect(asked.texts).toEqual([]);
    expect(existsSync(join(fixture.state, `${PROFILE_FILE}.bak`))).toBe(false);
  });

  test("should refuse with the scan's lines when the leak scan finds a hit", async () => {
    // Arrange
    const deps: SettingMoveDeps = {
      ...makeDeps(undefined, false, { texts: [] }),
      scan: async () => ({
        kind: "hits",
        code: 1,
        stdout: `${BASE_FILE}:2: email\n`,
        stderr: "",
      }),
    };

    // Act
    const result = await runSettingMove(
      { ...MOVE, yes: true },
      fixture.input,
      deps,
    );

    // Assert
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${BASE_FILE}:2: email\nrefused: the leak scan found the lines above.\n`,
    });
    expect(readRepo(fixture, BASE_FILE)).toBe(BASE_TEXT);
  });
});
