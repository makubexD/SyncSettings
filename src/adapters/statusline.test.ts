import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { renderStatusline } from "./statusline.ts";

const RESET = "\u001b[0m";
const CYAN = "\u001b[96m";
const YELLOW = "\u001b[93m";
const MAGENTA = "\u001b[95m";
const GRAY = "\u001b[90m";

const SEPARATOR = ` ${GRAY}|${RESET} `;
const TIME = "09:30";
const EMPTY_PAYLOAD = "{}";

/** The commit's age, so `%cr` prints the same `3 hours ago` every run. */
const AGE_MS = 3 * 60 * 60 * 1000;
const COMMIT_DATE = new Date(Date.now() - AGE_MS).toISOString();

/** A per-command identity: never written to any git config, local or global. */
const IDENTITY = [
  "-c",
  "user.name=Test User",
  "-c",
  "user.email=test@example.com",
] as const;

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-statusline-"));
  tempFolders.push(folder);
  return folder;
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

function paint(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

/** The variables that keep the line to the sections a case checks: no real
 * load, memory or git. */
function quietEnv(
  home: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    HOME: home,
    SYNC_LOAD: "",
    SYNC_MEM: "",
    SYNC_GIT: "none",
    ...overrides,
  };
}

function mergedEnv(
  extra: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/** Run a setup git command that must succeed. */
function git(
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): void {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv(env),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
}

/** A repo on `master` with one commit aged three hours: a modified tracked
 * file, a staged new file and one untracked file. */
function repoWithChanges(): string {
  const root = tempFolder();
  git(root, ["init", "-q", "-b", "master"]);
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  git(root, ["add", "-A"]);
  git(root, [...IDENTITY, "commit", "-q", "-m", "initial"], {
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_DATE: COMMIT_DATE,
  });
  writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(root, "c.txt"), "a\nb\n");
  git(root, ["add", "c.txt"]);
  writeFileSync(join(root, "u.txt"), "u\n");
  return root;
}

describe("renderStatusline", () => {
  test("should take the clock from the injected now", () => {
    // Arrange
    const home = tempFolder();
    const now = (): Date => new Date(2026, 0, 1, 7, 5);

    // Act
    const line = renderStatusline(EMPTY_PAYLOAD, {
      env: quietEnv(home),
      now,
    });

    // Assert
    expect(line).toBe(`${paint(GRAY, "07:05")}\n`);
  });

  test("should use SYNC_NOW as the time text", () => {
    // Arrange
    const home = tempFolder();

    // Act
    const line = renderStatusline(EMPTY_PAYLOAD, {
      env: quietEnv(home, { SYNC_NOW: TIME }),
    });

    // Assert
    expect(line).toBe(`${paint(GRAY, TIME)}\n`);
  });

  test("should use SYNC_LOAD as the load text", () => {
    // Arrange
    const home = tempFolder();

    // Act
    const line = renderStatusline(EMPTY_PAYLOAD, {
      env: quietEnv(home, { SYNC_NOW: TIME, SYNC_LOAD: "0.42" }),
    });

    // Assert
    expect(line).toBe(
      `${paint(GRAY, TIME)}${SEPARATOR}${paint(CYAN, "Load: 0.42")}\n`,
    );
  });

  test("should render SYNC_MEM as the memory section", () => {
    // Arrange
    const home = tempFolder();

    // Act
    const line = renderStatusline(EMPTY_PAYLOAD, {
      env: quietEnv(home, { SYNC_NOW: TIME, SYNC_MEM: "3.1G/15.5G" }),
    });

    // Assert
    expect(line).toBe(
      `${paint(GRAY, TIME)}${SEPARATOR}${paint(CYAN, "Mem: 3.1G/15.5G")}\n`,
    );
  });

  test("should leave the git sections out when SYNC_GIT is none", () => {
    // Arrange
    const home = tempFolder();
    const repo = repoWithChanges();

    // Act
    const line = renderStatusline(JSON.stringify({ cwd: repo }), {
      env: quietEnv(home, { SYNC_NOW: TIME }),
    });

    // Assert
    expect(line).toBe(
      `${paint(GRAY, TIME)}${SEPARATOR}${paint(YELLOW, basename(repo))}\n`,
    );
  });

  test("should not write the context window for a session id with a slash", () => {
    // Arrange
    const home = tempFolder();
    const ctxFolder = join(home, "ctx-window");
    const payload = JSON.stringify({
      session_id: "../x",
      context_window: { context_window_size: 200000 },
    });

    // Act
    renderStatusline(payload, {
      env: quietEnv(home, { SYNC_NOW: TIME, CTX_WINDOW_DIR: ctxFolder }),
    });

    // Assert
    expect(existsSync(ctxFolder)).toBe(false);
  });

  test("should write the window size for a valid session id", () => {
    // Arrange
    const home = tempFolder();
    const ctxFolder = join(home, "ctx-window");
    const payload = JSON.stringify({
      session_id: "abc-1",
      context_window: { context_window_size: 200000 },
    });

    // Act
    renderStatusline(payload, {
      env: quietEnv(home, { SYNC_NOW: TIME, CTX_WINDOW_DIR: ctxFolder }),
    });

    // Assert
    expect(readFileSync(join(ctxFolder, "abc-1"), "utf8")).toBe("200000\n");
  });

  test("should leave the git sections out when git is missing", () => {
    // Arrange
    const home = tempFolder();
    const emptyPath = tempFolder();

    // Act
    const line = renderStatusline(EMPTY_PAYLOAD, {
      env: quietEnv(home, {
        SYNC_NOW: TIME,
        SYNC_GIT: undefined,
        PATH: emptyPath,
      }),
    });

    // Assert
    expect(line).toBe(`${paint(GRAY, TIME)}\n`);
  });

  test("should read the branch, dirty mark, changes and age from a repo", () => {
    // Arrange
    const home = tempFolder();
    const repo = repoWithChanges();

    // Act
    const line = renderStatusline(JSON.stringify({ cwd: repo }), {
      env: quietEnv(home, { SYNC_NOW: TIME, SYNC_GIT: undefined }),
    });

    // Assert
    expect(line).toBe(
      `${paint(GRAY, TIME)}${SEPARATOR}${paint(YELLOW, basename(repo))}` +
        `${SEPARATOR}${paint(MAGENTA, "master* 3h")}` +
        `${SEPARATOR}${paint(YELLOW, "(+3,-1) 1?")}\n`,
    );
  });
});
