import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PreviewDiff } from "../adapters/git.ts";
import type { LeakScanResult } from "../adapters/leakscan.ts";
import { MATCHES_HEAD, NOTHING_WRITTEN } from "../core/plan/preview.ts";
import type { PreviewPlan } from "../core/plan/preview.ts";
import type { SanitizeRule } from "../core/config/types.ts";
import type { LocalEntry, RepoFiles, Snapshot } from "../core/plan/types.ts";
import type { Values } from "../core/values/sanitize.ts";
import { askExportValues, previewTail } from "./export.ts";
import type { PreviewTailDeps } from "./export.ts";

/** The prefix `previewTail` gives its temp folder, counted around each run. */
const TEMP_PREFIX = "mksync-preview-tail-";

/** The repo root the stubs are handed; none of them reads it. */
const REPO_ROOT = "/repo";

const STATUS_LINE = "MODIFIED dotfiles/linux/plain.txt";

/** Git's stat of the changed file, leading space and all, as it prints it. */
const STAT_TEXT =
  " dotfiles/linux/plain.txt | 1 +\n 1 file changed, 1 insertion(+)\n";

/** Git's full diff of the changed file. */
const DIFF_TEXT =
  "diff --git a/dotfiles/linux/plain.txt b/dotfiles/linux/plain.txt\n" +
  "@@ -1 +1,2 @@\n" +
  " plain\n" +
  "+preview change\n";

/** The scan's stdout on a hit: one line per hit, then the rule's hint. */
function hitText(file: string): string {
  return `${file}:1: home-path\n\nwrite $HOME or ~ instead of the full path.\n`;
}

const PLAIN_REPO_PATH = "dotfiles/linux/plain.txt";

const CONFIG_PATH = "sync-config.json";

const PACKAGES_PATH = "packages/linux/list.txt";

const PLAIN_REPO = new TextEncoder().encode("plain\nnext\n");

const CONFIG = new TextEncoder().encode("{}\n");

const PACKAGES = new TextEncoder().encode("tool\n");

/** The tree a preview hands `previewTail`: the two compared paths and one
 * under `packages/`, which the scan must not see. */
function tree(): RepoFiles {
  return new Map([
    [PLAIN_REPO_PATH, PLAIN_REPO],
    [CONFIG_PATH, CONFIG],
    [PACKAGES_PATH, PACKAGES],
  ]);
}

/** A preview plan with the tree part 1 hands the app. */
function preview(lines: readonly string[], withTree = true): PreviewPlan {
  const plan: PreviewPlan = { actions: [], lines, code: 0 };
  return withTree ? { ...plan, tree: tree() } : plan;
}

/** The lines a preview of one modified file ends with, before the tail. */
const CHANGED_LINES = [
  STATUS_LINE,
  "",
  "  --------------------------------------------------",
  "",
  "  1 file(s) would change.",
  NOTHING_WRITTEN,
  "",
];

/** Everything a failed scan or diff prints: the lines before the tail. */
const BEFORE_TAIL = `${CHANGED_LINES.slice(
  0,
  CHANGED_LINES.indexOf(NOTHING_WRITTEN),
).join("\n")}\n`;

/** What the stubs saw: the scan's paths and how often the diff ran. */
interface Calls {
  readonly scanPaths: (readonly string[])[];
  diffs: number;
}

/** Stubs for the scan and the diff, so no test needs bash or git. */
function deps(
  calls: Calls,
  scan: (paths: readonly string[]) => LeakScanResult,
  diff: () => PreviewDiff | undefined = () => ({
    stat: STAT_TEXT,
    diff: DIFF_TEXT,
  }),
): PreviewTailDeps {
  return {
    scan: async (_repoRoot, paths) => {
      calls.scanPaths.push(paths);
      return scan(paths);
    },
    diff: async () => {
      calls.diffs++;
      return diff();
    },
  };
}

function newCalls(): Calls {
  return { scanPaths: [], diffs: 0 };
}

const CLEAN: LeakScanResult = {
  kind: "clean",
  code: 0,
  stdout: "",
  stderr: "",
};

const COULD_NOT_RUN: LeakScanResult = {
  kind: "could-not-run",
  code: 2,
  stdout: "",
  stderr: "",
};

/** The temp folders of `previewTail` in tmpdir, counted around each run. */
function tempFolders(): readonly string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX));
}

describe("previewTail", () => {
  test("should print the scan line, stat and diff before the end when the scan is clean", async () => {
    // Arrange
    const calls = newCalls();
    const before = tempFolders();
    const written = new Map<string, string>();
    const stub = deps(calls, (paths) => {
      const root = dirname(paths[0] ?? "");
      for (const path of [PLAIN_REPO_PATH, CONFIG_PATH]) {
        written.set(path, readFileSync(join(root, path), "utf8"));
      }
      return CLEAN;
    });

    // Act
    const result = await previewTail(REPO_ROOT, preview(CHANGED_LINES), stub);

    // Assert
    expect(result.stdout.split("\n").slice(0, -1)).toEqual([
      STATUS_LINE,
      "",
      "  --------------------------------------------------",
      "",
      "  1 file(s) would change.",
      "  Leak scan: clean.",
      " dotfiles/linux/plain.txt | 1 +",
      " 1 file changed, 1 insertion(+)",
      "diff --git a/dotfiles/linux/plain.txt b/dotfiles/linux/plain.txt",
      "@@ -1 +1,2 @@",
      " plain",
      "+preview change",
      NOTHING_WRITTEN,
      "",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(written).toEqual(
      new Map([
        [PLAIN_REPO_PATH, "plain\nnext\n"],
        [CONFIG_PATH, "{}\n"],
      ]),
    );
    expect(tempFolders()).toEqual(before);
  });

  test("should insert the tail before the matches-HEAD line when the preview printed it", async () => {
    // Arrange
    const calls = newCalls();
    const lines = [STATUS_LINE, "", MATCHES_HEAD, NOTHING_WRITTEN, ""];

    // Act
    const result = await previewTail(
      REPO_ROOT,
      preview(lines),
      deps(calls, () => CLEAN),
    );

    // Assert
    expect(result.stdout.split("\n").slice(0, -1)).toEqual([
      STATUS_LINE,
      "",
      "  Leak scan: clean.",
      " dotfiles/linux/plain.txt | 1 +",
      " 1 file changed, 1 insertion(+)",
      "diff --git a/dotfiles/linux/plain.txt b/dotfiles/linux/plain.txt",
      "@@ -1 +1,2 @@",
      " plain",
      "+preview change",
      MATCHES_HEAD,
      NOTHING_WRITTEN,
      "",
    ]);
  });

  test("should scan only the temp copy's compared paths", async () => {
    // Arrange
    const calls = newCalls();

    // Act
    await previewTail(
      REPO_ROOT,
      preview(CHANGED_LINES),
      deps(calls, () => CLEAN),
    );

    // Assert
    const [paths] = calls.scanPaths;
    expect(paths).toHaveLength(2);
    const root = dirname(paths?.[0] ?? "");
    expect(basename(root).startsWith(TEMP_PREFIX)).toBe(true);
    expect(paths).toEqual([join(root, "dotfiles"), join(root, CONFIG_PATH)]);
  });

  test("should print the stripped hits and the WARNING without a diff when the scan found a leak", async () => {
    // Arrange
    const calls = newCalls();
    const before = tempFolders();
    const stub = deps(calls, (paths) => ({
      kind: "hits",
      code: 1,
      stdout: hitText(join(dirname(paths[0] ?? ""), PLAIN_REPO_PATH)),
      stderr: "",
    }));

    // Act
    const result = await previewTail(REPO_ROOT, preview(CHANGED_LINES), stub);

    // Assert
    const lines = result.stdout.split("\n").slice(0, -1);
    expect(lines).toContain(`${PLAIN_REPO_PATH}:1: home-path`);
    expect(lines).toContain(
      "  WARNING: the leak scan found the lines above. Fix them before committing.",
    );
    expect(result.stdout).not.toContain("diff --git");
    expect(result.stdout).toContain(NOTHING_WRITTEN);
    expect(result.code).toBe(1);
    expect(calls.diffs).toBe(0);
    expect(tempFolders()).toEqual(before);
  });

  test("should strip the temp folder from a hit when grep echoes it with a backslash", async () => {
    // Arrange
    const calls = newCalls();
    const stub = deps(calls, (paths) => ({
      kind: "hits",
      code: 1,
      stdout: hitText(`${dirname(paths[0] ?? "")}\\${PLAIN_REPO_PATH}`),
      stderr: "",
    }));

    // Act
    const result = await previewTail(REPO_ROOT, preview(CHANGED_LINES), stub);

    // Assert
    const lines = result.stdout.split("\n").slice(0, -1);
    expect(lines).toContain(`${PLAIN_REPO_PATH}:1: home-path`);
    expect(result.stdout).not.toContain(TEMP_PREFIX);
  });

  test("should stop with the ERROR on stderr and no end lines when the scan cannot run", async () => {
    // Arrange
    const calls = newCalls();
    const before = tempFolders();

    // Act
    const result = await previewTail(
      REPO_ROOT,
      preview(CHANGED_LINES),
      deps(calls, () => COULD_NOT_RUN),
    );

    // Assert
    expect(result.stdout).toBe(BEFORE_TAIL);
    expect(result.stderr).toBe(
      "ERROR: leak scan could not run; nothing was committed.\n",
    );
    expect(result.code).toBe(1);
    expect(calls.diffs).toBe(0);
    expect(tempFolders()).toEqual(before);
  });

  test("should stop with the git diff ERROR when the comparison fails", async () => {
    // Arrange
    const calls = newCalls();
    const before = tempFolders();

    // Act
    const result = await previewTail(
      REPO_ROOT,
      preview(CHANGED_LINES),
      deps(
        calls,
        () => CLEAN,
        () => undefined,
      ),
    );

    // Assert
    expect(result.stdout).toBe(BEFORE_TAIL);
    expect(result.stderr).toBe("ERROR: git diff failed.\n");
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Leak scan");
    expect(tempFolders()).toEqual(before);
  });

  test("should print the plan as it is when it holds no tree", async () => {
    // Arrange
    const calls = newCalls();

    // Act
    const result = await previewTail(
      REPO_ROOT,
      preview([STATUS_LINE, NOTHING_WRITTEN, ""], false),
      deps(calls, () => CLEAN),
    );

    // Assert
    expect(result.stdout).toBe(`${STATUS_LINE}\n${NOTHING_WRITTEN}\n\n`);
    expect(result.code).toBe(0);
    expect(calls.scanPaths).toEqual([]);
    expect(calls.diffs).toBe(0);
  });
});

describe("askExportValues", () => {
  const ASK_HOME = "/home/user";
  const LOGIN = "<YOUR_GH_USERNAME>";
  const SUGGESTED = "parity-user";
  const TYPED = "other-user";
  const LOCAL = `${ASK_HOME}/.config/parity/a.conf`;
  const QUESTION =
    "  GitHub username (~/.config/parity/a.conf) [parity-user]: ";
  const RULE: SanitizeRule = {
    placeholder: LOGIN,
    prompt: "GitHub username",
    suggest: "gh-login",
  };

  function local(): LocalEntry {
    return {
      kind: "file",
      path: LOCAL,
      bytes: new TextEncoder().encode("color = blue\n"),
      mode: 0o644,
    };
  }

  function askSnapshot(): Snapshot {
    return {
      config: {
        schemaVersion: 2,
        modules: { parity: { description: "Parity case files" } },
        entries: [
          {
            file: "parity/a.conf",
            module: "parity",
            merge: "whole",
            localPath: "~/.config/parity/a.conf",
            sanitize: [RULE],
          },
        ],
      },
      os: "linux",
      home: ASK_HOME,
      cwd: ASK_HOME,
      repoFiles: new Map(),
      localFiles: new Map([[LOCAL, local()]]),
      localDirs: new Set(),
      values: {},
      env: {},
      only: [],
    };
  }

  /** A terminal answering with `lines`, then end of input; records what it printed. */
  function terminal(lines: readonly string[]): {
    readonly io: {
      write(text: string): void;
      readLine(): Promise<string | undefined>;
    };
    readonly printed: string[];
  } {
    const printed: string[] = [];
    const left = [...lines];
    return {
      printed,
      io: {
        write: (text) => {
          printed.push(text);
        },
        readLine: async () => left.shift(),
      },
    };
  }

  /** A suggestion source that records each run. */
  function suggesting(): {
    readonly suggest: (rules: readonly SanitizeRule[]) => Promise<Values>;
    readonly runs: number[];
  } {
    const runs: number[] = [];
    return {
      runs,
      suggest: async (rules) => {
        runs.push(rules.length);
        return { [LOGIN]: SUGGESTED };
      },
    };
  }

  test("should show the suggestion and take it on Enter", async () => {
    // Arrange
    const { io, printed } = terminal([""]);
    const { suggest } = suggesting();

    // Act
    const asked = await askExportValues(askSnapshot(), io, false, suggest);

    // Assert
    expect(printed).toContain(QUESTION);
    expect(asked.ok && asked.snapshot.values[LOGIN]).toBe(SUGGESTED);
  });

  test("should take a typed answer over the suggestion", async () => {
    const { io } = terminal([TYPED]);
    const { suggest } = suggesting();

    const asked = await askExportValues(askSnapshot(), io, false, suggest);

    expect(asked.ok && asked.snapshot.values[LOGIN]).toBe(TYPED);
  });

  test("should never take the suggestion at end of input", async () => {
    const { io } = terminal([]);
    const { suggest } = suggesting();

    const asked = await askExportValues(askSnapshot(), io, false, suggest);

    expect(asked.ok).toBe(false);
  });

  test("should ask nothing and run no source under --yes", async () => {
    const { io, printed } = terminal([""]);
    const { suggest, runs } = suggesting();

    const asked = await askExportValues(askSnapshot(), io, true, suggest);

    expect(asked.ok && asked.snapshot.values).toEqual({});
    expect(printed).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("should run no source when nothing is asked", async () => {
    const { io } = terminal([]);
    const { suggest, runs } = suggesting();
    const filled = { ...askSnapshot(), values: { [LOGIN]: TYPED } };

    await askExportValues(filled, io, false, suggest);

    expect(runs).toEqual([]);
  });
});
