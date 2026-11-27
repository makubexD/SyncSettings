import { describe, expect, test } from "bun:test";

import type { Result } from "./export.ts";
import type { MoveSession, PushDeps, PushInput } from "./push.ts";
import { askMoves, executePush, pickChoice } from "./push.ts";

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
    askValues: async () => undefined,
    askChoice: async () => undefined,
    recordProfile: () => undefined,
    offersKeep: () => false,
    runImport: async () => ({ code: 0, stdout: "", stderr: "" }),
    runKeptImport: async () => ({ code: 0, stdout: "", stderr: "" }),
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
    cleanHead: async () => undefined,
    recordSyncPoint: () => ({ warning: "", refused: undefined }),
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
      "\n",
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
    expect(out.texts).toEqual([
      MOVE_QUESTION,
      `Move it to? ${TARGETS} [1] `,
      "\n",
    ]);
  });

  test("should end the question's line when the input ends at the first question", async () => {
    // Arrange
    const reader = scripted([undefined]);
    const out = collector();

    // Act
    const result = await askMoves(fakeSession(), reader.read, out.write);

    // Assert
    expect(result).toEqual({ ok: true, value: undefined });
    expect(out.texts).toEqual([MOVE_QUESTION, "\n"]);
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

  test("the value questions come before the guard's diff", async () => {
    // Arrange
    const order: string[] = [];

    // Act
    await runGuarded(diffOf(["OUT", A]), pushInput(), {
      askValues: async () => {
        order.push("values");
        return undefined;
      },
      runDiff: async () => {
        order.push("diff");
        return diffOf(["OUT", A]);
      },
    });

    // Assert
    expect(order).toEqual(["values", "diff"]);
  });

  test("a stopped value question ends the push before the guard", async () => {
    // Arrange
    const stopped = { code: 1, stdout: "", stderr: "missing value\n" };

    // Act
    const run = await runGuarded(diffOf(["OUT", A]), pushInput(), {
      askValues: async () => stopped,
    });

    // Assert
    expect(run.result).toEqual(stopped);
    expect(run.diffs).toEqual([]);
    expect(run.exports).toEqual([]);
  });

  test("values saved into the repo folder don't stop an IN push", async () => {
    // Arrange
    let saved = false;

    // Act
    const run = await runGuarded(diffOf(["IN", B], ["OUT", A]), pushInput(), {
      askValues: async () => {
        saved = true;
        return undefined;
      },
      guardedClean: async () => !saved,
    });

    // Assert
    expect(run.exports).toEqual([{ only: [], skip: [B] }]);
  });

  test("--yes still checks the values before the guard", async () => {
    // Arrange
    const stopped = { code: 1, stdout: "", stderr: "missing value\n" };

    // Act
    const run = await runGuarded(diffOf(["OUT", A]), pushInput({ yes: true }), {
      askValues: async () => stopped,
    });

    // Assert
    expect(run.result).toEqual(stopped);
    expect(run.exports).toEqual([]);
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
    const run = await runGuarded(diffOf(["OUT", A]), pushInput({ paths: [A] }));

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

    expect(run.result).toEqual({
      code: 1,
      stdout: KEPT,
      stderr: "fatal: no\n",
    });
  });

  test("a yes restores nothing", async () => {
    const run = await decline({ ask: async () => true });

    expect(run.restored).toEqual([]);
    expect(run.result.stdout).toBe("committed\n");
  });
});

const C = "dotfiles/common/parity/c.conf";
const CHOICE_QUESTION =
  "  Send this machine's version (s), take the repo's (r) or skip (k)? [s/r/k] ";
const PICK_CHOICE = "  Pick s, r or k.\n";
const FIRST_SYNC_NOTHING = "  Nothing to send.\n";
const IMPORTED = { code: 0, stdout: "UPDATED b\n", stderr: "" };
const IMPORT_FAILED = { code: 1, stdout: "", stderr: "import failed\n" };

/** A first-sync diff: every path labeled `?`, each with one changed line. */
function unknownDiff(...paths: string[]): Result {
  return {
    code: 3,
    stdout: "",
    stderr: "",
    diff: {
      skipped: [],
      labels: paths.map((path) => ({ label: "?" as const, path })),
      conflictLines: [],
      lineCounts: new Map(paths.map((path) => [path, 1])),
    },
  };
}

/** Run an interactive push with no sync point, answering the picker from
 * `answers`, recording the imports and the export's skip list. */
async function runPicker(
  answers: (string | undefined)[],
  overrides: Partial<PushDeps> = {},
  input: PushInput = pushInput(),
): Promise<{
  result: Result;
  imports: (readonly string[])[];
  skips: (readonly string[])[];
  keeps: (readonly string[])[];
  calls: string[];
  commits: boolean[];
  questions: string[];
  printed: string;
}> {
  const imports: (readonly string[])[] = [];
  const skips: (readonly string[])[] = [];
  const keeps: (readonly string[])[] = [];
  const calls: string[] = [];
  const commits: boolean[] = [];
  const questions: string[] = [];
  let printed = "";
  const result = await executePush(
    input,
    baseDeps({
      hasSyncPoint: async () => false,
      runDiff: async () => unknownDiff(C, A, B),
      askChoice: async (question) => {
        questions.push(question);
        return answers.shift();
      },
      runImport: async (take) => {
        imports.push(take);
        calls.push("import");
        return IMPORTED;
      },
      runKeptImport: async (keep) => {
        imports.push(keep);
        calls.push("kept import");
        return IMPORTED;
      },
      runExport: async (_only, _yes, skip, keep) => {
        skips.push(skip);
        keeps.push(keep);
        calls.push("export");
        return EXPORTED;
      },
      ask: async () => true,
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
  return {
    result,
    imports,
    skips,
    keeps,
    calls,
    commits,
    questions,
    printed,
  };
}

describe("executePush first-sync picker", () => {
  test("asks each file in path order with its line count", async () => {
    // Arrange
    const answers = ["s", "s", "s"];

    // Act
    const run = await runPicker(answers);

    // Assert
    expect(run.printed).toContain(
      `\n  ${A}  1 line(s) changed\n` +
        `\n  ${B}  1 line(s) changed\n` +
        `\n  ${C}  1 line(s) changed\n` +
        "\n",
    );
  });

  test("s sends, r imports and k skips, with a partial commit", async () => {
    // Arrange
    const answers = ["s", "r", "k"];

    // Act
    const run = await runPicker(answers);

    // Assert
    expect(run.imports).toEqual([[B]]);
    expect(run.skips).toEqual([[B, C]]);
    expect(run.commits).toEqual([true]);
  });

  test("s for every file sends them all with a full commit", async () => {
    // Arrange
    const answers = ["s", "S", " s "];

    // Act
    const run = await runPicker(answers);

    // Assert
    expect(run.imports).toEqual([]);
    expect(run.skips).toEqual([[]]);
    expect(run.commits).toEqual([false]);
  });

  test("any other answer prints the pick line and asks again", async () => {
    // Arrange
    const answers = ["x", "", "s", "k", "k"];

    // Act
    const run = await runPicker(answers);

    // Assert
    expect(run.questions).toHaveLength(5);
    expect(run.printed.split(PICK_CHOICE)).toHaveLength(3);
    expect(run.skips).toEqual([[B, C]]);
  });

  test("end of input skips that file and every one after it", async () => {
    // Arrange
    const answers = ["s", undefined];

    // Act
    const run = await runPicker(answers);

    // Assert
    expect(run.questions).toEqual([CHOICE_QUESTION, CHOICE_QUESTION]);
    expect(run.printed).not.toContain(C);
    expect(run.skips).toEqual([[B, C]]);
  });

  test("no file sent prints Nothing to send. after the imports", async () => {
    // Arrange
    const answers = ["r", "k", undefined];

    // Act
    const run = await runPicker(answers);

    // Assert
    expect(run.imports).toEqual([[A]]);
    expect(run.skips).toEqual([]);
    expect(run.result).toEqual({
      code: 0,
      stdout: FIRST_SYNC_NOTHING,
      stderr: "",
    });
  });

  test("a failed import stops the push before the export", async () => {
    // Arrange
    const answers = ["r", "s", "s"];

    // Act
    const run = await runPicker(answers, {
      runImport: async () => IMPORT_FAILED,
    });

    // Assert
    expect(run.result).toEqual(IMPORT_FAILED);
    expect(run.skips).toEqual([]);
  });

  test("--yes keeps the warning and asks nothing", async () => {
    // Arrange
    const answers = ["k", "k", "k"];

    // Act
    const run = await runPicker(answers, {}, pushInput({ yes: true }));

    // Assert
    expect(run.questions).toEqual([]);
    expect(run.printed).toContain("WARNING: no sync is recorded");
    expect(run.skips).toEqual([[]]);
  });
});

const WORK_PROFILE = "work-1";
const KEEP_QUESTION_WORK =
  "  Send this machine's version (s), keep its differences in profile work-1 (p), take the repo's (r) or skip (k)? [p] ";
const KEEP_QUESTION_PERSONAL =
  "  Send this machine's version (s), keep its differences in profile personal (p), take the repo's (r) or skip (k)? [s] ";
const PICK_CHOICE_KEEP = "  Pick s, p, r or k.\n";
const KEPT_WARNING =
  "  WARNING: no sync is recorded on this machine; the differences of 2 file(s) stay in profile work-1, the rest are sent.\n";
const WORK_OFFER = {
  keep: true,
  profile: WORK_PROFILE,
  suggestion: "p",
} as const;
const NO_OFFER = { keep: false } as const;

/** A work record whose picker offers `p` for every file but `C`. */
const WORK_RECORD: Partial<PushDeps> = {
  recordProfile: () => WORK_PROFILE,
  offersKeep: (path) => path !== C,
};

describe("pickChoice", () => {
  test.each<[string, string]>([
    ["s", "s"],
    ["p", "p"],
    ["r", "r"],
    ["k", "k"],
    [" P ", "p"],
    ["", "p"],
  ])("should read %p as %p when p is offered", (answer, choice) => {
    expect(pickChoice(answer, WORK_OFFER) as string | undefined).toBe(choice);
  });

  test.each<[string]>([["p"], [""], ["x"]])(
    "should read %p as no choice when p is not offered",
    (answer) => {
      expect(pickChoice(answer, NO_OFFER)).toBeUndefined();
    },
  );
});

describe("executePush first-sync picker with p", () => {
  test("should offer p with the work suggestion and ask without it where not offered", async () => {
    // Arrange
    const answers = ["s", "s", "s"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.questions).toEqual([
      KEEP_QUESTION_WORK,
      KEEP_QUESTION_WORK,
      CHOICE_QUESTION,
    ]);
  });

  test("should suggest s on personal and take it on Enter", async () => {
    // Arrange
    const answers = ["", "", "s"];

    // Act
    const run = await runPicker(answers, {
      ...WORK_RECORD,
      recordProfile: () => "personal",
    });

    // Assert
    expect(run.questions[0]).toBe(KEEP_QUESTION_PERSONAL);
    expect(run.skips).toEqual([[]]);
    expect(run.commits).toEqual([false]);
  });

  test("should keep a file on Enter on a work profile, not skip it", async () => {
    // Arrange
    const answers = ["", "p", "k"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.skips).toEqual([[C]]);
    expect(run.keeps).toEqual([[A, B]]);
    expect(run.commits).toEqual([true]);
  });

  test("should import the kept files after the export when p is answered", async () => {
    // Arrange
    const answers = ["p", "p", "k"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.calls).toEqual(["export", "kept import"]);
    expect(run.imports).toEqual([[A, B]]);
  });

  test("should print the kept files' import after the export's lines", async () => {
    // Arrange
    const answers = ["p", "k", "k"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.printed).toContain(EXPORTED.stdout + IMPORTED.stdout);
  });

  test("should print the first-sync nothing-to-send line when only kept files changed", async () => {
    // Arrange
    const answers = ["p", "p", "s"];

    // Act
    const run = await runPicker(answers, {
      ...WORK_RECORD,
      statusShort: async () => ({ ok: true, stdout: "" }),
    });

    // Assert
    expect(run.result.stdout).toBe(
      EXPORTED.stdout + IMPORTED.stdout + FIRST_SYNC_NOTHING,
    );
  });

  test("should run no import after the export when nothing is kept", async () => {
    // Arrange
    const answers = ["s", "s", "s"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.calls).toEqual(["export"]);
  });

  test("should stop the push with the import's code when the kept files' import fails", async () => {
    // Arrange
    const answers = ["p", "s", "s"];

    // Act
    const run = await runPicker(answers, {
      ...WORK_RECORD,
      runKeptImport: async () => IMPORT_FAILED,
    });

    // Assert
    expect(run.result.code).toBe(IMPORT_FAILED.code);
    expect(run.commits).toEqual([]);
  });

  test("should not offer p without a record", async () => {
    // Arrange
    const answers = ["s", "s", "s"];

    // Act
    const run = await runPicker(answers, { offersKeep: () => true });

    // Assert
    expect(run.questions).toEqual([
      CHOICE_QUESTION,
      CHOICE_QUESTION,
      CHOICE_QUESTION,
    ]);
  });

  test("should print the p pick line where p is offered and the old one where not", async () => {
    // Arrange: A and B offer p, C doesn't; p on C is no answer there.
    const answers = ["x", "s", "s", "p", "s"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.printed.split(PICK_CHOICE_KEEP)).toHaveLength(2);
    expect(run.printed.split(PICK_CHOICE)).toHaveLength(2);
  });

  test("should skip the rest at end of input even where p is suggested", async () => {
    // Arrange
    const answers = ["p", undefined];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.questions).toHaveLength(2);
    expect(run.skips).toEqual([[B, C]]);
  });

  test("should run the export when every file is kept", async () => {
    // Arrange
    const answers = ["p", "p", "s"];

    // Act
    const run = await runPicker(answers, WORK_RECORD);

    // Assert
    expect(run.result.stdout).not.toBe(FIRST_SYNC_NOTHING);
    expect(run.skips).toEqual([[]]);
  });

  test("--yes on a work record keeps the p files after the warning that names the profile", async () => {
    // Arrange
    const answers: string[] = [];

    // Act
    const run = await runPicker(answers, WORK_RECORD, pushInput({ yes: true }));

    // Assert
    expect(run.questions).toEqual([]);
    expect(run.printed).toStartWith(KEPT_WARNING);
    expect(run.skips).toEqual([[]]);
  });

  test("--yes on personal sends everything after the old warning", async () => {
    // Arrange
    const answers: string[] = [];

    // Act
    const run = await runPicker(
      answers,
      { ...WORK_RECORD, recordProfile: () => "personal" },
      pushInput({ yes: true }),
    );

    // Assert
    expect(run.printed).toContain(
      "WARNING: no sync is recorded on this machine, so this sends every file that differs.",
    );
  });
});

const CLEAN_HEAD = "1a2b3c4d5e6f";
const SYNC_POINT_WARNING =
  "  WARNING: could not record the sync point in /state/last-sync.\n";
const SYNC_POINT_REFUSED = "ERROR: refused to write the sync point.";

/** Run the picker with a clean clone at `origin/master` unless overridden,
 * recording each sync point written. */
async function runRecorded(
  answers: (string | undefined)[],
  overrides: Partial<PushDeps> = {},
  input: PushInput = pushInput(),
): Promise<{ result: Result; recorded: string[] }> {
  const recorded: string[] = [];
  const run = await runPicker(
    answers,
    {
      statusShort: async () => ({ ok: true, stdout: "" }),
      cleanHead: async () => CLEAN_HEAD,
      recordSyncPoint: (sha) => {
        recorded.push(sha);
        return { warning: "", refused: undefined };
      },
      ...overrides,
    },
    input,
  );
  return { result: run.result, recorded };
}

describe("executePush sync point when nothing is sent", () => {
  test("should record HEAD when every file takes the repo's version", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers);

    // Assert
    expect(run.recorded).toEqual([CLEAN_HEAD]);
    expect(run.result).toEqual({
      code: 0,
      stdout: FIRST_SYNC_NOTHING,
      stderr: "",
    });
  });

  test("should record HEAD when every file stays in the profile or is taken", async () => {
    // Arrange
    const answers = ["p", "p", "r"];

    // Act
    const run = await runRecorded(answers, WORK_RECORD);

    // Assert
    expect(run.recorded).toEqual([CLEAN_HEAD]);
    expect(run.result.code).toBe(0);
  });

  test("should record nothing when a file is skipped", async () => {
    // Arrange
    const answers = ["r", "k", "r"];

    // Act
    const run = await runRecorded(answers);

    // Assert
    expect(run.recorded).toEqual([]);
  });

  test("should record nothing when paths were picked", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers, {}, pushInput({ paths: [A] }));

    // Assert
    expect(run.recorded).toEqual([]);
  });

  test("should record nothing when the clone is dirty or not at origin/master", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers, {
      cleanHead: async () => undefined,
    });

    // Assert
    expect(run.recorded).toEqual([]);
    expect(run.result.code).toBe(0);
  });

  test("should record nothing when the fetch failed", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers, {
      originState: async () => ({ fetchOk: false, behind: 0 }),
    });

    // Assert
    expect(run.recorded).toEqual([]);
  });

  test("should stop before recording when the clone is behind origin", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers, {
      originState: async () => BEHIND,
    });

    // Assert
    expect(run.recorded).toEqual([]);
    expect(run.result.stderr).toBe(BEHIND_ORIGIN);
  });

  test("should record HEAD after an export that sent nothing with a sync point", async () => {
    // Arrange
    const recorded: string[] = [];

    // Act
    const run = await runGuarded(diffOf(), pushInput(), {
      statusShort: async () => ({ ok: true, stdout: "" }),
      cleanHead: async () => CLEAN_HEAD,
      recordSyncPoint: (sha) => {
        recorded.push(sha);
        return { warning: "", refused: undefined };
      },
    });

    // Assert
    expect(recorded).toEqual([CLEAN_HEAD]);
    expect(run.result.stdout).toBe(EXPORTED.stdout + NOTHING_TO_SEND);
  });

  test("should add the warning when the sync point can't be written", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers, {
      recordSyncPoint: () => ({
        warning: SYNC_POINT_WARNING,
        refused: undefined,
      }),
    });

    // Assert
    expect(run.result).toEqual({
      code: 0,
      stdout: FIRST_SYNC_NOTHING + SYNC_POINT_WARNING,
      stderr: "",
    });
  });

  test("should stop with exit 1 when the sync point write is refused", async () => {
    // Arrange
    const answers = ["r", "r", "r"];

    // Act
    const run = await runRecorded(answers, {
      recordSyncPoint: () => ({ warning: "", refused: SYNC_POINT_REFUSED }),
    });

    // Assert
    expect(run.result).toEqual({
      code: 1,
      stdout: FIRST_SYNC_NOTHING,
      stderr: `${SYNC_POINT_REFUSED}\n`,
    });
  });
});
