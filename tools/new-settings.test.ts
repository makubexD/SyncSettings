import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "new-settings.ts");

const HEADING = "New settings in this PR";

const GIT_USER = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.com",
  "-c",
  "commit.gpgsign=false",
];

const temporaryRepos: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryRepos.map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
}

/** One run of the real script inside a fixture repo. */
interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function git(repo: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

async function writeFiles(
  repo: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const target = join(repo, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, [...GIT_USER, "commit", "--allow-empty", "-q", "-m", message]);
}

/** A temp repo with a base commit, the change, then the head commit. */
async function makeRepo(
  baseFiles: Record<string, string>,
  change: (repo: string) => Promise<void>,
): Promise<Fixture> {
  const repo = await mkdtemp(join(tmpdir(), "mksync-new-settings-"));
  temporaryRepos.push(repo);
  git(repo, ["init", "-q"]);
  await writeFiles(repo, baseFiles);
  commit(repo, "base");
  await change(repo);
  commit(repo, "head");
  return {
    repo,
    base: git(repo, ["rev-parse", "HEAD~1"]).trim(),
    head: git(repo, ["rev-parse", "HEAD"]).trim(),
  };
}

function run(fixture: Fixture, ...refs: string[]): Run {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...refs], {
    cwd: fixture.repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The exact comment body the contract asks for. */
function body(...lines: string[]): string {
  if (lines.length === 0) {
    return `${HEADING}\n\nNo new settings.\n`;
  }
  return `${HEADING}\n\n${lines.map((line) => `${line}\n`).join("")}`;
}

/** A v2 config with one whole-file entry per given file. */
function config(files: readonly string[]): string {
  const entries = files.map((file) => ({
    file,
    module: "shell",
    merge: "whole",
    localPath: `~/${file}`,
  }));
  return `${JSON.stringify({ schemaVersion: 2, entries }, null, 2)}\n`;
}

describe("new-settings", () => {
  test("no change prints No new settings.", async () => {
    const fixture = await makeRepo(
      {
        "sync-config.json": config(["dotfiles/linux/x.json"]),
        "dotfiles/linux/x.json": '{"a": 1}\n',
      },
      async () => {},
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(body());
  });

  test("a new entry in sync-config.json is listed", async () => {
    const fixture = await makeRepo(
      { "sync-config.json": config([]) },
      async (repo) => {
        await writeFiles(repo, {
          "sync-config.json": config(["dotfiles/linux/.tmux.conf"]),
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(body("entry dotfiles/linux/.tmux.conf"));
  });

  test("a new file under dotfiles/ is listed with no key lines", async () => {
    const fixture = await makeRepo(
      { "sync-config.json": config([]) },
      async (repo) => {
        await writeFiles(repo, {
          "dotfiles/linux/new.conf": "set -g mouse on\n",
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(body("file dotfiles/linux/new.conf"));
  });

  test("a new key in a changed JSON file is listed, the kept key is not", async () => {
    const fixture = await makeRepo(
      { "dotfiles/linux/x.json": '{"a": {"kept": 1}}\n' },
      async (repo) => {
        await writeFiles(repo, {
          "dotfiles/linux/x.json": '{"a": {"kept": 1, "b": 2}}\n',
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(body("key dotfiles/linux/x.json: a.b"));
  });

  test("new files under profiles/ and machines/ are listed", async () => {
    const fixture = await makeRepo(
      { "sync-config.json": config([]) },
      async (repo) => {
        await writeFiles(repo, {
          "profiles/work/settings.json": '{"a": 1}\n',
          "machines/work-1/record.json": '{"b": 2}\n',
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      body(
        "file machines/work-1/record.json",
        "file profiles/work/settings.json",
      ),
    );
  });

  test("an unparsable JSON file on the head side lists no keys", async () => {
    const fixture = await makeRepo(
      { "dotfiles/linux/bad.json": '{"a": 1}\n' },
      async (repo) => {
        await writeFiles(repo, { "dotfiles/linux/bad.json": "{ not json\n" });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(body());
  });

  test("an unparsable JSON file on the base side lists no keys", async () => {
    const fixture = await makeRepo(
      { "dotfiles/linux/bad.json": "{ not json\n" },
      async (repo) => {
        await writeFiles(repo, { "dotfiles/linux/bad.json": '{"a": 1}\n' });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(body());
  });

  test("an array is one value: a new item is not listed, a new array key is", async () => {
    const fixture = await makeRepo(
      { "dotfiles/linux/x.json": '{"a": [1]}\n' },
      async (repo) => {
        await writeFiles(repo, {
          "dotfiles/linux/x.json": '{"a": [1, {"c": 2}], "b": [3]}\n',
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(body("key dotfiles/linux/x.json: b"));
  });

  test("a JSON file saved with a BOM still lists its new keys", async () => {
    const fixture = await makeRepo(
      { "dotfiles/linux/x.json": '﻿{"a": 1}\n' },
      async (repo) => {
        await writeFiles(repo, {
          "dotfiles/linux/x.json": '﻿{"a": 1, "b": 2}\n',
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(body("key dotfiles/linux/x.json: b"));
  });

  test("the lines come out sorted", async () => {
    const fixture = await makeRepo(
      {
        "sync-config.json": config([]),
        "dotfiles/linux/k.json": "{}\n",
      },
      async (repo) => {
        await writeFiles(repo, {
          // The config order and the key order are both reversed on purpose.
          "sync-config.json": config([
            "dotfiles/linux/z.conf",
            "dotfiles/linux/a.conf",
          ]),
          "dotfiles/linux/k.json": '{"b": 1, "a": 2}\n',
        });
      },
    );

    const result = run(fixture, fixture.base, fixture.head);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      body(
        "entry dotfiles/linux/a.conf",
        "entry dotfiles/linux/z.conf",
        "key dotfiles/linux/k.json: a",
        "key dotfiles/linux/k.json: b",
      ),
    );
  });

  test("an unknown ref prints ERROR and exits 2", async () => {
    const fixture = await makeRepo(
      { "sync-config.json": config([]) },
      async () => {},
    );

    const result = run(fixture, "no-such-ref", fixture.head);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.startsWith("ERROR: ")).toBe(true);
    expect(result.stderr.trim().length).toBeGreaterThan("ERROR: ".length);
  });
});
