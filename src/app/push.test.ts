import { describe, expect, test } from "bun:test";

import type { Result } from "./export.ts";
import type { MoveSession, PushDeps, PushInput } from "./push.ts";
import { askMoves, executePush } from "./push.ts";

const MOVE_QUESTION =
  "Move a change? Type its number, or press Enter to go on: ";
const TARGETS =
  "1) all machines  2) Linux machines  3) profile work-1  4) this machine";
const EXPORTED = { code: 0, stdout: "  the block\n", stderr: "" };
const STATUS = " M dotfiles/linux/tool/config\n";
const NOTHING_TO_SEND = "  Nothing to send: the repo matches this machine.\n";
const BEHIND_ORIGIN = "ERROR: origin has updates; run mksync pull first.\n";
const UP_TO_DATE = { fetchOk: true, behind: 0 };
const BEHIND = { fetchOk: true, behind: 1 };

/** A session with three changes, all in group 1 unless overridden. */
function fakeSession(overrides: Partial<MoveSession> = {}): MoveSession {
  return {
    lineCount: 3,
    groupOf: () => 1,
    targets: TARGETS,
    move: () => ({ ok: true, value: "  moved block\n" }),
    ...overrides,
  };
}

/** Scripted answers, recording each question read. */
function scripted(script: (string | undefined)[]): {
  read: (question: string) => Promise<string | undefined>;
  questions: string[];
} {
  const questions: string[] = [];
  return {
    questions,
    read: async (question: string): Promise<string | undefined> => {
      questions.push(question);
      return script.shift();
    },
  };
}

/** Collected writes. */
function collector(): {
  write: (text: string) => void;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    write: (text: string): void => {
      texts.push(text);
    },
  };
}

function pushInput(overrides: Partial<PushInput> = {}): PushInput {
  return { yes: false, force: false, paths: [], ...overrides };
}

const A = "dotfiles/common/parity/a.conf";
const B = "dotfiles/common/parity/b.conf";
const IN_LINES =
  `  IN         ${B}\n` +
  "  1 file(s) are newer in the repo and were left alone; run mksync pull to take them.\n";
const BLOCK = ["  --- repo", "  +++ this machine", "  @@ -1 +1 @@"];
const DIFF_FAILED = { code: 1, stdout: "reason\n", stderr: "bad\n" };
const COULD_NOT_TELL =
  "  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync push --force.\n";

function diffOf(...labels: ["IN" | "OUT" | "BOTH", string][]): Result {
  return {
    code: labels.length === 0 ? 0 : 3,
    stdout: "",
    stderr: "",
    diff: {
      skipped: [],
      labels: labels.map(([label, path]) => ({ label, path })),
      conflictLines: labels.some(([label]) => label === "BOTH") ? BLOCK : [],
    },
  };
}

/** Run a push, recording what its guard passed on. */
async function runGuarded(
  diff: Result,
  input: PushInput,
  overrides: Partial<PushDeps> = {},
) {
  const exports: { only: readonly string[]; skip: readonly string[] }[] = [];
  const commits: boolean[] = [];
  const diffs: { only: readonly string[]; conflicts: boolean }[] = [];
  const questions: { question: string; defaultYes: boolean }[] = [];
  let printed = "";
  const result = await executePush(
    input,
    baseDeps({
      hasSyncPoint: async () => true,
      runDiff: async (only, conflicts) => {
        diffs.push({ only, conflicts });
        return diff;
      },
      runExport: async (only, _yes, skip) => {
        exports.push({ only, skip });
        return EXPORTED;
      },
      ask: async (question, defaultYes) => {
        questions.push({ question, defaultYes });
        return true;
      },
      print: (shown) => {
        printed += shown.stdout;
      },
      runCommit: async (partial) => {
        commits.push(partial);
        return { code: 0, stdout: "", stderr: "" };
      },
      ...overrides,
    }),
  );
  return { result, exports, commits, diffs, questions, printed };
}

function baseDeps(overrides: Partial<PushDeps> = {}): PushDeps {
  return {
    refusal: async () => undefined,
    hasSyncPoint: async () => true,
    runDiff: async () => diffOf(),
    runExport: async () => EXPORTED,
    statusShort: async () => ({ ok: true, stdout: STATUS }),
    stateStamp: () => "same",
    guardedClean: async () => true,
    pathsClean: async () => true,
    changedFiles: async () => ({ tracked: [A], untracked: [] }),
    restoreFiles: async () => undefined,
    ask: async () => true,
    print: () => {},
    runCommit: async () => ({ code: 0, stdout: "committed\n", stderr: "" }),
    cloneReady: async () => true,
    originState: async () => UP_TO_DATE,
    ...overrides,
  };
}

describe("askMoves", () => {
  test("Enter at once moves nothing and writes only the prompt", async () => {
    const reader = scripted([""]);
    const out = collector();

    const result = await askMoves(fakeSession(), reader.read, out.write);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(out.texts).toEqual([MOVE_QUESTION]);
    expect(reader.questions).toEqual([MOVE_QUESTION]);
  });

  test("move line 2 to group 3 and print the block again", async () => {
    const calls: { line: number; group: number }[] = [];
    const session = fakeSession({
      move: (line, group) => {
        calls.push({ line, group });
        return { ok: true, value: "  moved block\n" };
      },
    });
    const reader = scripted(["2", "3"]);
    const out = collector();

    await askMoves(session, reader.read, out.write);

    expect(calls).toEqual([{ line: 2, group: 3 }]);
    expect(out.texts).toContain("  moved block\n");
    expect(reader.questions).toEqual([
      MOVE_QUESTION,
      `Move it to? ${TARGETS} [1] `,
      MOVE_QUESTION,
    ]);
  });

  test("a line past the block prints Pick 1 to 3 and asks again", async () => {
    const reader = scripted(["9", ""]);
    const out = collector();

    await askMoves(fakeSession({ lineCount: 3 }), reader.read, out.write);

    expect(out.texts).toEqual([MOVE_QUESTION, "Pick 1 to 3.\n", MOVE_QUESTION]);
    expect(reader.questions).toEqual([MOVE_QUESTION, MOVE_QUESTION]);
  });

  test("a target past 4 prints Pick 1 to 4 and asks again", async () => {
    const reader = scripted(["1", "7", "", undefined]);
    const out = collector();

    await askMoves(fakeSession(), reader.read, out.write);

    expect(out.texts).toEqual([
      MOVE_QUESTION,
      `Move it to? ${TARGETS} [1] `,
      "Pick 1 to 4.\n",
      `Move it to? ${TARGETS} [1] `,
      MOVE_QUESTION,
    ]);
    expect(reader.questions).toEqual([
      MOVE_QUESTION,
      `Move it to? ${TARGETS} [1] `,
      `Move it to? ${TARGETS} [1] `,
      MOVE_QUESTION,
    ]);
  });

  test("the end of input on the target question ends the loop", async () => {
    const reader = scripted(["1", undefined]);
    const out = collector();

    const result = await askMoves(fakeSession(), reader.read, out.write);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(out.texts).toEqual([MOVE_QUESTION, `Move it to? ${TARGETS} [1] `]);
  });

  test("a move error is returned and ends the loop", async () => {
    const reader = scripted(["1", "2"]);
    const out = collector();

    const result = await askMoves(
      fakeSession({ move: () => ({ ok: false, error: "no layer machine" }) }),
      reader.read,
      out.write,
    );

    expect(result).toEqual({ ok: false, error: "no layer machine" });
    expect(out.texts).toEqual([MOVE_QUESTION, `Move it to? ${TARGETS} [1] `]);
  });
});

describe("executePush", () => {
  test("Nothing to send when the repo matches", async () => {
    const deps = baseDeps({
      statusShort: async () => ({ ok: true, stdout: "" }),
    });

    const result = await executePush(pushInput(), deps);

    expect(result).toEqual({
      code: 0,
      stdout: EXPORTED.stdout + NOTHING_TO_SEND,
      stderr: "",
    });
  });

  test("a clone that is not ready stops before the export", async () => {
    let exported = false;
    const deps = baseDeps({
      cloneReady: async () => false,
      runExport: async () => {
        exported = true;
        return EXPORTED;
      },
    });

    const result = await executePush(pushInput(), deps);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "ERROR: push needs the repo clone on master with an origin remote.\n",
    });
    expect(exported).toBe(false);
  });

  test("a repo behind origin stops before the export and commits nothing", async () => {
    let exported = false;
    let committed = false;
    const deps = baseDeps({
      originState: async () => BEHIND,
      runExport: async () => {
        exported = true;
        return EXPORTED;
      },
      runCommit: async () => {
        committed = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const result = await executePush(pushInput({ yes: true }), deps);

    expect(result).toEqual({ code: 1, stdout: "", stderr: BEHIND_ORIGIN });
    expect(exported).toBe(false);
    expect(committed).toBe(false);
  });

  test("a failed fetch skips the behind check and the export runs", async () => {
    let exported = false;
    const deps = baseDeps({
      originState: async () => ({ fetchOk: false, behind: 1 }),
      runExport: async () => {
        exported = true;
        return EXPORTED;
      },
    });

    const result = await executePush(pushInput({ yes: true }), deps);

    expect(result.code).toBe(0);
    expect(exported).toBe(true);
  });

  test("an up-to-date repo goes on to the export", async () => {
    let exported = false;
    const deps = baseDeps({
      originState: async () => UP_TO_DATE,
      runExport: async () => {
        exported = true;
        return EXPORTED;
      },
    });

    const result = await executePush(pushInput({ yes: true }), deps);

    expect(result.code).toBe(0);
    expect(exported).toBe(true);
  });

  test("an export stopped by the up-to-date pull is returned as it is", async () => {
    const pulled = {
      code: 0,
      stdout: "Pulled 2 commit(s); run the command again.\n",
      stderr: "",
      stopped: true,
    };
    let asked = false;
    let committed = false;
    const deps = baseDeps({
      runExport: async () => pulled,
      ask: async () => {
        asked = true;
        return true;
      },
      runCommit: async () => {
        committed = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const result = await executePush(pushInput(), deps);

    expect(result).toEqual({
      code: 0,
      stdout: "Pulled 2 commit(s); run the command again.\n",
      stderr: "",
    });
    expect(asked).toBe(false);
    expect(committed).toBe(false);
  });

  test("a failed git status keeps the export's stderr", async () => {
    const deps = baseDeps({
      runExport: async () => ({ ...EXPORTED, stderr: "WARN x\n" }),
      statusShort: async () => ({ ok: false, stdout: "" }),
    });

    const result = await executePush(pushInput(), deps);

    expect(result.stderr.startsWith("WARN x\n")).toBe(true);
    expect(result.stderr.endsWith("ERROR: git status failed.\n")).toBe(true);
  });
});

describe("executePush guard", () => {
  test("OUT files are sent in a full push", async () => {
    const run = await runGuarded(diffOf(["OUT", A]), pushInput());

    expect(run.exports).toEqual([{ only: [], skip: [] }]);
    expect(run.commits).toEqual([false]);
    expect(run.diffs).toEqual([{ only: [], conflicts: true }]);
    expect(run.questions).toEqual([
      { question: "  Open a PR with these changes? [y/N] ", defaultYes: false },
    ]);
  });

  test("an IN file is skipped and the commit is partial", async () => {
    const run = await runGuarded(diffOf(["OUT", A], ["IN", B]), pushInput());

    expect(run.printed).toBe(IN_LINES + EXPORTED.stdout + STATUS);
    expect(run.exports).toEqual([{ only: [], skip: [B] }]);
    expect(run.commits).toEqual([true]);
  });

  test("an IN file stops a push from a repo folder with changes", async () => {
    const run = await runGuarded(
      diffOf(["OUT", A], ["IN", B]),
      pushInput({ yes: true, force: true }),
      { guardedClean: async () => false },
    );

    expect(run.result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "  ERROR: the repo folder has changes not sent yet, and they can hold older versions of these files; run git stash -u, then push again.\n",
    });
    expect(run.printed).toBe(IN_LINES);
    expect(run.exports).toEqual([]);
    expect(run.commits).toEqual([]);
  });

  test("changes in the repo folder pass without an IN file", async () => {
    const run = await runGuarded(diffOf(["OUT", A]), pushInput(), {
      guardedClean: async () => false,
    });

    expect(run.commits).toEqual([false]);
  });

  test("only an IN file leaves nothing to send", async () => {
    const run = await runGuarded(diffOf(["IN", B]), pushInput(), {
      statusShort: async () => ({ ok: true, stdout: "" }),
    });

    expect(run.printed).toBe(IN_LINES);
    expect(run.result.stdout).toBe(`${EXPORTED.stdout}  Nothing to send.\n`);
    expect(run.result.code).toBe(0);
    expect(run.commits).toEqual([]);
  });

  test("a BOTH file stops before the export, --yes included", async () => {
    const run = await runGuarded(
      diffOf(["IN", A], ["BOTH", B]),
      pushInput({ yes: true }),
    );

    expect(run.result).toEqual({
      code: 1,
      stdout: `  BOTH       ${B}\n${BLOCK.join("\n")}\n`,
      stderr:
        "  ERROR: 1 file(s) changed on both sides since the last sync.\n" +
        "  Merge by hand, then run mksync push --force <path>; or mksync pull --force <path> takes the repo's version (keeps a .bak).\n",
    });
    expect(run.printed).toBe("");
    expect(run.exports).toEqual([]);
  });

  test("force sends BOTH in a full push and still asks", async () => {
    const run = await runGuarded(
      diffOf(["BOTH", B]),
      pushInput({ force: true }),
    );

    expect(run.exports).toEqual([{ only: [], skip: [] }]);
    expect(run.printed).toBe(EXPORTED.stdout + STATUS);
    expect(run.diffs).toEqual([{ only: [], conflicts: false }]);
    expect(run.questions.length).toBe(1);
    expect(run.commits).toEqual([false]);
  });

  test("force still leaves an IN file alone", async () => {
    const run = await runGuarded(
      diffOf(["BOTH", A], ["IN", B]),
      pushInput({ force: true, yes: true }),
    );

    expect(run.exports).toEqual([{ only: [], skip: [B] }]);
    expect(run.printed).toStartWith(IN_LINES);
    expect(run.questions).toEqual([]);
    expect(run.commits).toEqual([true]);
  });

  test("a failed diff stops before the export", async () => {
    const run = await runGuarded(DIFF_FAILED, pushInput({ yes: true }));

    expect(run.result).toEqual({ code: 1, stdout: "", stderr: COULD_NOT_TELL });
    expect(run.exports).toEqual([]);
  });

  test("a failed diff of picked paths shows its reason", async () => {
    const run = await runGuarded(DIFF_FAILED, pushInput({ paths: ["typo"] }));

    expect(run.result).toEqual({
      code: 1,
      stdout: "reason\n",
      stderr: COULD_NOT_TELL,
    });
  });

  test("a diff that carries no labels counts as failed", async () => {
    const run = await runGuarded(
      { code: 0, stdout: "", stderr: "" },
      pushInput(),
    );

    expect(run.result.stderr).toBe(COULD_NOT_TELL);
  });

  test("force passes a failed diff with a partial commit", async () => {
    const run = await runGuarded(DIFF_FAILED, pushInput({ force: true }));

    expect(run.exports).toEqual([{ only: [], skip: [] }]);
    expect(run.commits).toEqual([true]);
  });

  test("no sync point warns, runs no diff and sends everything", async () => {
    const run = await runGuarded(
      diffOf(["BOTH", B]),
      pushInput({ yes: true }),
      { hasSyncPoint: async () => false },
    );

    expect(run.printed).toStartWith(
      "  WARNING: no sync is recorded on this machine, so this sends every file that differs.\n",
    );
    expect(run.diffs).toEqual([]);
    expect(run.exports).toEqual([{ only: [], skip: [] }]);
    expect(run.commits).toEqual([false]);
  });

  test("picked paths narrow the diff and make the commit partial", async () => {
    const run = await runGuarded(
      diffOf(["OUT", A]),
      pushInput({ paths: [A] }),
    );

    expect(run.diffs).toEqual([{ only: [A], conflicts: true }]);
    expect(run.exports).toEqual([{ only: [A], skip: [] }]);
    expect(run.commits).toEqual([true]);
  });

  test("a record refusal stops before the origin check and the guard", async () => {
    const refused = { code: 1, stdout: "", stderr: "ERROR: pull-only\n" };
    const run = await runGuarded(diffOf(), pushInput(), {
      refusal: async () => refused,
      originState: async () => BEHIND,
    });

    expect(run.result).toEqual(refused);
    expect(run.diffs).toEqual([]);
    expect(run.exports).toEqual([]);
  });
});

describe("executePush declined", () => {
  const CHANGED = { tracked: [A], untracked: [B] };
  const KEPT =
    "  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.\n";

  /** Run a declined push, recording what it asked git to put back. */
  async function decline(overrides: Partial<PushDeps> = {}) {
    const restored: unknown[] = [];
    const order: string[] = [];
    const result = await executePush(
      pushInput(),
      baseDeps({
        pathsClean: async () => {
          order.push("clean");
          return true;
        },
        runExport: async () => {
          order.push("export");
          return { ...EXPORTED, repoPaths: [A, B] };
        },
        changedFiles: async () => {
          order.push("list");
          return CHANGED;
        },
        ask: async () => {
          order.push("ask");
          return false;
        },
        restoreFiles: async (files) => {
          restored.push(files);
          return undefined;
        },
        ...overrides,
      }),
    );
    return { result, restored, order };
  }

  test("a clean repo folder is put back", async () => {
    const run = await decline();

    expect(run.result).toEqual({
      code: 0,
      stdout: "  Nothing sent; the repo folder is as it was.\n",
      stderr: "",
    });
    expect(run.restored).toEqual([CHANGED]);
    expect(run.order).toEqual(["clean", "export", "list", "ask"]);
  });

  test("only what the export wrote is put back", async () => {
    const run = await decline({
      changedFiles: async () => ({
        tracked: [A, "packages/linux/apt.txt"],
        untracked: ["dotfiles/mine.txt", "profiles/work-1.json"],
      }),
    });

    expect(run.restored).toEqual([
      { tracked: [A], untracked: ["profiles/work-1.json"] },
    ]);
  });

  test("an export that changed local state keeps every file", async () => {
    const stamps = ["before", "after"];
    const run = await decline({ stateStamp: () => stamps.shift() ?? "" });

    expect(run.result).toEqual({ code: 0, stdout: KEPT, stderr: "" });
    expect(run.restored).toEqual([]);
  });

  test("a repo folder with changes keeps every file", async () => {
    const run = await decline({ pathsClean: async () => false });

    expect(run.result).toEqual({ code: 0, stdout: KEPT, stderr: "" });
    expect(run.restored).toEqual([]);
  });

  test("files git can't list are kept", async () => {
    const run = await decline({ changedFiles: async () => undefined });

    expect(run.result).toEqual({ code: 0, stdout: KEPT, stderr: "" });
    expect(run.restored).toEqual([]);
  });

  test("a failed restore prints git's error and exits 1", async () => {
    const run = await decline({ restoreFiles: async () => "fatal: no\n" });

    expect(run.result).toEqual({ code: 1, stdout: KEPT, stderr: "fatal: no\n" });
  });

  test("a yes restores nothing", async () => {
    const run = await decline({ ask: async () => true });

    expect(run.restored).toEqual([]);
    expect(run.result.stdout).toBe("committed\n");
  });
});
