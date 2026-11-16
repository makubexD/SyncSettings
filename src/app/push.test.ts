import { describe, expect, test } from "bun:test";

import type { MoveSession, PushDeps } from "./push.ts";
import { askMoves, executePush } from "./push.ts";

const MOVE_QUESTION =
  "Move a change? Type its number, or press Enter to go on: ";
const TARGETS =
  "1) all machines  2) Linux machines  3) profile work-1  4) this machine";
const EXPORTED = { code: 0, stdout: "  the block\n", stderr: "" };
const STATUS = " M dotfiles/linux/tool/config\n";
const NOTHING_TO_SEND = "  Nothing to send: the repo matches this machine.\n";

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

function baseDeps(overrides: Partial<PushDeps> = {}): PushDeps {
  return {
    runExport: async () => EXPORTED,
    statusShort: async () => ({ ok: true, stdout: STATUS }),
    ask: async () => true,
    print: () => {},
    runCommit: async () => ({ code: 0, stdout: "committed\n", stderr: "" }),
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

    expect(out.texts).toEqual([
      MOVE_QUESTION,
      "Pick 1 to 3.\n",
      MOVE_QUESTION,
    ]);
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
    expect(out.texts).toEqual([
      MOVE_QUESTION,
      `Move it to? ${TARGETS} [1] `,
    ]);
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
    expect(out.texts).toEqual([
      MOVE_QUESTION,
      `Move it to? ${TARGETS} [1] `,
    ]);
  });
});

describe("executePush", () => {
  test("--yes never asks for moves", async () => {
    let called = false;
    const deps = baseDeps({
      moves: async () => {
        called = true;
        return fakeSession();
      },
      readAnswer: async () => "",
    });

    const result = await executePush({ yes: true, paths: [] }, deps);

    expect(called).toBe(false);
    expect(result.code).toBe(0);
  });

  test("no session asks nothing", async () => {
    let reads = 0;
    const printed: string[] = [];
    const deps = baseDeps({
      moves: async () => undefined,
      readAnswer: async () => {
        reads += 1;
        return undefined;
      },
      print: (shown) => {
        printed.push(shown.stdout);
      },
    });

    await executePush({ yes: false, paths: [] }, deps);

    expect(reads).toBe(0);
    expect(printed).toEqual([EXPORTED.stdout + STATUS]);
  });

  test("the block prints before the questions and git status", async () => {
    const events: string[] = [];
    const deps = baseDeps({
      runExport: async () => {
        events.push("export");
        return EXPORTED;
      },
      moves: async () => {
        events.push("moves");
        return fakeSession();
      },
      print: (shown) => {
        events.push(`print:${shown.stdout}`);
      },
      readAnswer: async () => {
        events.push("read");
        return "";
      },
      statusShort: async () => {
        events.push("status");
        return { ok: true, stdout: STATUS };
      },
      ask: async () => {
        events.push("pr");
        return true;
      },
      runCommit: async () => {
        events.push("commit");
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await executePush({ yes: false, paths: [] }, deps);

    expect(events).toEqual([
      "export",
      "moves",
      `print:${EXPORTED.stdout}`,
      `print:${MOVE_QUESTION}`,
      "read",
      "status",
      `print:${STATUS}`,
      "pr",
      "commit",
    ]);
  });

  test("Nothing to send when the repo matches", async () => {
    const deps = baseDeps({
      statusShort: async () => ({ ok: true, stdout: "" }),
    });

    const result = await executePush({ yes: false, paths: [] }, deps);

    expect(result).toEqual({
      code: 0,
      stdout: EXPORTED.stdout + NOTHING_TO_SEND,
      stderr: "",
    });
  });
});
