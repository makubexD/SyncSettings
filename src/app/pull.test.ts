import { describe, expect, test } from "bun:test";
import { DEFAULT_NO, yesNoAnswer } from "../core/answer.ts";
import type { AnswerDefaults } from "../core/answer.ts";
import type { Result } from "./export.ts";
import { executePull } from "./pull.ts";
import type { FetchResult, PullDeps, PullInput } from "./pull.ts";

const OK: Result = { code: 0, stdout: "", stderr: "" };

const CHECK_OUTPUT = "  UPDATE     dotfiles/common/parity/a.conf\n";

const IMPORT_OUTPUT = "  UPDATED    dotfiles/common/parity/a.conf\n";

const OUT_LINE = "  OUT        dotfiles/common/parity/a.conf";

const BOTH_LINE = "  BOTH       dotfiles/common/parity/a.conf";

const IN_LINE = "  IN         dotfiles/common/parity/a.conf";

const NOTHING_APPLIED = "  Nothing applied.\n";

const NO_SYNC_QUESTION =
  "  No sync is recorded on this machine: if you changed these files here, a pull overwrites them (each keeps a .bak).\n" +
  "  Apply these changes? [y/N] ";

const APPLY_QUESTION = "  Apply these changes? [Y/n] ";

const FORCE_QUESTION = "  Apply these changes? [y/N] ";

/** After the guard passed an empty answer applies; end of input doesn't. */
const APPLY_ANSWERS: AnswerDefaults = { empty: true, end: false };

/** Typed answers, as the terminal hands them over. */
const YES = "y";
const NO = "n";
const EMPTY = "";

const CONFLICT_LINES = [
  "  --- repo           dotfiles/common/parity/a.conf",
  "  +++ this machine   dotfiles/common/parity/a.conf",
  "  @@ -1 +1 @@",
  "  -repo line",
  "  +machine line",
];

const BLOCK = CONFLICT_LINES.map((line) => `${line}\n`).join("");

const NO_SYNC_ERROR =
  "  ERROR: no sync is recorded on this machine, so a pull can't tell which side changed these files.\n" +
  "  Run mksync diff, then mksync push, mksync pull <path> without --yes, or mksync pull --force (each keeps a .bak).\n";

const CLONE_ERROR =
  "ERROR: pull needs the repo clone on master with an origin remote.\n";

const UNSENT_ERROR =
  "ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.\n";

const CHANGED: Result = { code: 3, stdout: CHECK_OUTPUT, stderr: "" };

/** What the flow asked its children and its questions. */
interface Calls {
  readonly checks: (readonly string[])[];
  readonly diffs: (readonly string[])[];
  readonly imports: (readonly string[])[];
  fetch: number;
  readonly questions: {
    readonly question: string;
    readonly answers: AnswerDefaults;
  }[];
  /** Everything flushed before a question, in order. */
  readonly printed: Result[];
  /** The value questions and the check, in the order they ran. */
  readonly steps: string[];
}

/** The answers a scenario gives to its questions, in order. */
interface Scenario {
  readonly cloneReady?: boolean;
  readonly unsent?: number;
  readonly fetch?: FetchResult;
  readonly check?: Result;
  readonly diff?: Result;
  readonly importResult?: Result;
  readonly hasSyncPoint?: boolean;
  /** Typed answers; once they run out, every question meets end of input. */
  readonly answers?: readonly string[];
  readonly valuesStop?: Result;
}

/** A flow whose every dep answers as the scenario needs. */
function deps(given: Scenario = {}): {
  readonly deps: PullDeps;
  readonly calls: Calls;
} {
  const calls: {
    checks: (readonly string[])[];
    diffs: (readonly string[])[];
    imports: (readonly string[])[];
    fetch: number;
    questions: { question: string; answers: AnswerDefaults }[];
    printed: Result[];
    steps: string[];
  } = {
    checks: [],
    diffs: [],
    imports: [],
    fetch: 0,
    questions: [],
    printed: [],
    steps: [],
  };
  const answers = [...(given.answers ?? [])];
  const built: PullDeps = {
    askValues: async () => {
      calls.steps.push("values");
      return given.valuesStop;
    },
    runCheck: async (only) => {
      calls.steps.push("check");
      calls.checks.push(only);
      return given.check ?? OK;
    },
    runDiff: async (only) => {
      calls.diffs.push(only);
      return given.diff ?? OK;
    },
    runImport: async (only) => {
      calls.imports.push(only);
      return given.importResult ?? OK;
    },
    unsent: async () => given.unsent ?? 0,
    fetchAndFastForward: async () => {
      calls.fetch++;
      return given.fetch ?? { ok: true };
    },
    hasSyncPoint: async () => given.hasSyncPoint ?? true,
    ask: async (question, means) => {
      calls.questions.push({ question, answers: means });
      return yesNoAnswer(answers.shift(), means);
    },
    print: (shown) => {
      calls.printed.push(shown);
    },
    cloneReady: async () => given.cloneReady ?? true,
  };
  return { deps: built, calls };
}

function pullInput(given: Partial<PullInput> = {}): PullInput {
  return { yes: false, force: false, paths: [], ...given };
}

describe("executePull", () => {
  test("should refuse when the clone is not on master with an origin", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ cloneReady: false });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({ code: 1, stdout: "", stderr: CLONE_ERROR });
    expect(calls.fetch).toBe(0);
    expect(calls.checks).toEqual([]);
  });

  test("should refuse unsent changes before any fetch", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ unsent: 1 });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({ code: 1, stdout: "", stderr: UNSENT_ERROR });
    expect(calls.fetch).toBe(0);
    expect(calls.checks).toEqual([]);
  });

  test("should stop with the fetch error", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      fetch: { ok: false, message: "ERROR: could not reach origin." },
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "ERROR: could not reach origin.\n",
    });
    expect(calls.checks).toEqual([]);
  });

  test("should use the default fetch error when none is given", async () => {
    // Arrange
    const { deps: fake } = deps({ fetch: { ok: false } });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result.stderr).toBe("ERROR: could not reach origin.\n");
  });

  test("should print no pull count when nothing was fast-forwarded", async () => {
    // Arrange
    const { deps: fake } = deps({
      fetch: { ok: true, pulled: 0 },
      check: CHANGED,
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result.stdout).toBe(CHECK_OUTPUT + IMPORT_OUTPUT);
    expect(result.stdout).not.toContain("Pulled");
  });

  test("should print the fast-forwarded count before the check output", async () => {
    // Arrange
    const { deps: fake } = deps({
      fetch: { ok: true, pulled: 2 },
      check: CHANGED,
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result.stdout).toBe(
      `  Pulled 2 commit(s).\n${CHECK_OUTPUT}${IMPORT_OUTPUT}`,
    );
  });

  test("should run the import to record the sync point when nothing changes", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: IMPORT_OUTPUT,
      stderr: "",
    });
    expect(calls.checks).toEqual([[]]);
    expect(calls.imports).toEqual([[]]);
  });

  test("should return a partial pull's check code without importing", async () => {
    // Arrange
    const { deps: fake, calls } = deps();

    // Act
    const result = await executePull(
      pullInput({ paths: ["dotfiles/common/parity/a.conf"] }),
      fake,
    );

    // Assert
    expect(result).toEqual(OK);
    expect(calls.checks).toEqual([["dotfiles/common/parity/a.conf"]]);
    expect(calls.imports).toEqual([]);
  });

  test("should return a failing check's code unchanged", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: { code: 1, stdout: "", stderr: "ERROR: bad\n" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({ code: 1, stdout: "", stderr: "ERROR: bad\n" });
    expect(calls.diffs).toEqual([]);
    expect(calls.imports).toEqual([]);
  });

  test("should refuse a first pull under --yes without a sync point", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      hasSyncPoint: false,
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({
      code: 1,
      stdout: CHECK_OUTPUT,
      stderr: NO_SYNC_ERROR,
    });
    expect(calls.diffs).toEqual([]);
    expect(calls.imports).toEqual([]);
  });

  test("should warn and ask with a no default for a first interactive pull", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      hasSyncPoint: false,
      answers: [NO],
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: NOTHING_APPLIED,
      stderr: "",
    });
    expect(calls.questions).toEqual([
      { question: NO_SYNC_QUESTION, answers: DEFAULT_NO },
    ]);
    expect(calls.imports).toEqual([]);
  });

  test("should apply nothing on an empty answer to a first interactive pull", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      hasSyncPoint: false,
      answers: [EMPTY],
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({ code: 0, stdout: NOTHING_APPLIED, stderr: "" });
    expect(calls.imports).toEqual([]);
  });

  test("should import a first interactive pull when the answer is yes", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      hasSyncPoint: false,
      answers: [YES],
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
    });

    // Act
    const result = await executePull(
      pullInput({ paths: ["dotfiles/common/parity/a.conf"] }),
      fake,
    );

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: IMPORT_OUTPUT,
      stderr: "",
    });
    expect(calls.imports).toEqual([["dotfiles/common/parity/a.conf"]]);
  });

  test("should apply nothing when a first pull without --yes gets no answer", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      hasSyncPoint: false,
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith("  Nothing applied.\n")).toBe(true);
    expect(calls.imports).toEqual([]);
  });

  test("should stop on an OUT line from the diff", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: { code: 3, stdout: `${OUT_LINE}\n`, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({
      code: 1,
      stdout: `${CHECK_OUTPUT}${OUT_LINE}\n`,
      stderr:
        "  ERROR: 1 file(s) changed on this machine since the last sync, and a pull would overwrite them.\n" +
        "  Run mksync push first, or mksync pull --force to overwrite them (each keeps a .bak).\n",
    });
    expect(calls.imports).toEqual([]);
  });

  test("should stop on a BOTH line from the diff", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: { code: 3, stdout: `${BOTH_LINE}\n`, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${CHECK_OUTPUT}${BOTH_LINE}\n`);
    expect(result.stderr).toContain(
      "  ERROR: 1 file(s) changed on this machine",
    );
    expect(calls.imports).toEqual([]);
  });

  test("should count every blocking label line", async () => {
    // Arrange
    const { deps: fake } = deps({
      check: CHANGED,
      diff: { code: 3, stdout: `${OUT_LINE}\n${BOTH_LINE}\n`, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result.stderr).toContain(
      "  ERROR: 2 file(s) changed on this machine",
    );
    expect(result.stdout).toBe(`${CHECK_OUTPUT}${OUT_LINE}\n${BOTH_LINE}\n`);
  });

  test("should print the block after the BOTH line", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: {
        code: 3,
        stdout: `${BOTH_LINE}\n`,
        stderr: "",
        diff: {
          skipped: [],
          labels: [{ label: "BOTH", path: "dotfiles/common/parity/a.conf" }],
          conflictLines: CONFLICT_LINES,
        },
      },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({
      code: 1,
      stdout: `${CHECK_OUTPUT}${BOTH_LINE}\n${BLOCK}`,
      stderr:
        "  ERROR: 1 file(s) changed on this machine since the last sync, and a pull would overwrite them.\n" +
        "  Run mksync push first, or mksync pull --force to overwrite them (each keeps a .bak).\n",
    });
    expect(calls.imports).toEqual([]);
  });

  test("should print no block for an OUT-only diff", async () => {
    // Arrange
    const { deps: fake } = deps({
      check: CHANGED,
      diff: {
        code: 3,
        stdout: `${OUT_LINE}\n`,
        stderr: "",
        diff: {
          skipped: [],
          labels: [{ label: "OUT", path: "dotfiles/common/parity/a.conf" }],
          conflictLines: [],
        },
      },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${CHECK_OUTPUT}${OUT_LINE}\n`);
  });

  test("should print every blocking label before the block of a BOTH file", async () => {
    // Arrange
    const { deps: fake } = deps({
      check: CHANGED,
      diff: {
        code: 3,
        stdout: `${OUT_LINE}\n${BOTH_LINE}\n`,
        stderr: "",
        diff: {
          skipped: [],
          labels: [
            { label: "OUT", path: "dotfiles/common/parity/a.conf" },
            { label: "BOTH", path: "dotfiles/common/parity/a.conf" },
          ],
          conflictLines: CONFLICT_LINES,
        },
      },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      `${CHECK_OUTPUT}${OUT_LINE}\n${BOTH_LINE}\n${BLOCK}`,
    );
  });

  test("should apply when the diff has only IN lines", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: { code: 3, stdout: `${IN_LINE}\n`, stderr: "" },
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: CHECK_OUTPUT + IMPORT_OUTPUT,
      stderr: "",
    });
    expect(calls.imports).toEqual([[]]);
  });

  test("should stop when the diff cannot tell which side is newer", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: { code: 1, stdout: "", stderr: "ERROR: cannot read HEAD.\n" },
    });

    // Act
    const result = await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(result).toEqual({
      code: 1,
      stdout: CHECK_OUTPUT,
      stderr:
        "  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync pull --force.\n",
    });
    expect(calls.imports).toEqual([]);
  });

  test("should skip the diff with --force", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
    });

    // Act
    const result = await executePull(
      pullInput({ yes: true, force: true }),
      fake,
    );

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: CHECK_OUTPUT + IMPORT_OUTPUT,
      stderr: "",
    });
    expect(calls.diffs).toEqual([]);
    expect(calls.imports).toEqual([[]]);
  });

  test("should print the check output before it asks the apply question", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ check: CHANGED, answers: [NO] });

    // Act
    await executePull(pullInput(), fake);

    // Assert
    expect(calls.printed).toEqual([CHANGED]);
  });

  test("should ask the apply question with a yes default and import on y", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
      answers: [YES],
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({ code: 0, stdout: IMPORT_OUTPUT, stderr: "" });
    expect(calls.questions).toEqual([
      { question: APPLY_QUESTION, answers: APPLY_ANSWERS },
    ]);
    expect(calls.imports).toEqual([[]]);
  });

  test("should import when the apply question gets an empty answer", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: { code: 3, stdout: `${IN_LINE}\n`, stderr: "" },
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
      answers: [EMPTY],
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({ code: 0, stdout: IMPORT_OUTPUT, stderr: "" });
    expect(calls.imports).toEqual([[]]);
  });

  test.each([
    ["n", NO],
    ["x", "x"],
  ])(
    "should apply nothing when the apply question gets %s",
    async (_label, typed) => {
      // Arrange
      const { deps: fake, calls } = deps({
        check: CHANGED,
        diff: { code: 3, stdout: `${IN_LINE}\n`, stderr: "" },
        answers: [typed],
      });

      // Act
      const result = await executePull(pullInput(), fake);

      // Assert
      expect(result).toEqual({ code: 0, stdout: NOTHING_APPLIED, stderr: "" });
      expect(calls.imports).toEqual([]);
    },
  );

  test("should apply nothing when the apply question meets end of input", async () => {
    // Arrange: no typed answers, so the question meets end of input.
    const { deps: fake, calls } = deps({
      check: CHANGED,
      diff: { code: 3, stdout: `${IN_LINE}\n`, stderr: "" },
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({ code: 0, stdout: NOTHING_APPLIED, stderr: "" });
    expect(calls.imports).toEqual([]);
  });

  test("should ask [y/N] under --force and apply nothing on an empty answer", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      answers: [EMPTY],
    });

    // Act
    const result = await executePull(pullInput({ force: true }), fake);

    // Assert
    expect(result).toEqual({ code: 0, stdout: NOTHING_APPLIED, stderr: "" });
    expect(calls.questions).toEqual([
      { question: FORCE_QUESTION, answers: DEFAULT_NO },
    ]);
    expect(calls.imports).toEqual([]);
  });

  test("should import under --force when the question gets Y", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      importResult: { code: 0, stdout: IMPORT_OUTPUT, stderr: "" },
      answers: ["Y"],
    });

    // Act
    const result = await executePull(pullInput({ force: true }), fake);

    // Assert
    expect(result).toEqual({ code: 0, stdout: IMPORT_OUTPUT, stderr: "" });
    expect(calls.imports).toEqual([[]]);
  });

  test("should print Nothing applied and exit 0 when the apply question is declined", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      check: CHANGED,
      answers: [NO],
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual({
      code: 0,
      stdout: NOTHING_APPLIED,
      stderr: "",
    });
    expect(calls.imports).toEqual([]);
  });

  test("should answer the apply question with --yes", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ check: CHANGED });

    // Act
    await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(calls.questions).toEqual([]);
    expect(calls.imports).toEqual([[]]);
  });

  test("should pass the picked paths to the check, the diff and the import", async () => {
    // Arrange
    const paths = ["a.conf", "b.conf"];
    const { deps: fake, calls } = deps({ check: CHANGED });

    // Act
    await executePull(pullInput({ yes: true, paths }), fake);

    // Assert
    expect(calls.checks).toEqual([paths]);
    expect(calls.diffs).toEqual([paths]);
    expect(calls.imports).toEqual([paths]);
  });
});

const PULLED_TWO = "  Pulled 2 commit(s).\n";
const VALUES_REFUSED: Result = {
  code: 1,
  stdout: "",
  stderr: "ERROR: refused to write the values file.\n",
};

describe("executePull value questions", () => {
  test("should ask the values before the check when interactive", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ check: CHANGED, answers: [YES] });

    // Act
    await executePull(pullInput(), fake);

    // Assert
    expect(calls.steps).toEqual(["values", "check"]);
  });

  test("should ask nothing under --yes", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ check: CHANGED });

    // Act
    await executePull(pullInput({ yes: true }), fake);

    // Assert
    expect(calls.steps).toEqual(["check"]);
  });

  test("should print the fast-forwarded count before the questions", async () => {
    // Arrange
    const { deps: fake, calls } = deps({
      fetch: { ok: true, pulled: 2 },
      check: CHANGED,
      answers: [YES],
    });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(calls.printed[0]?.stdout).toBe(PULLED_TWO);
    expect(result.stdout).not.toContain(PULLED_TWO);
  });

  test("should go on to the check when the questions go on unanswered", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ check: CHANGED, answers: [YES] });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(calls.checks).toEqual([[]]);
    expect(result.code).toBe(0);
  });

  test("should stop before the check when the questions stop", async () => {
    // Arrange
    const { deps: fake, calls } = deps({ valuesStop: VALUES_REFUSED });

    // Act
    const result = await executePull(pullInput(), fake);

    // Assert
    expect(result).toEqual(VALUES_REFUSED);
    expect(calls.checks).toEqual([]);
  });
});
