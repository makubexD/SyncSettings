import { describe, expect, test } from "bun:test";
import { PULL_FAILED, pulledLine, upToDateAction } from "./uptodate.ts";
import type { UpToDateFacts } from "./uptodate.ts";

const NOTE =
  "  NOTE: could not reach origin; skipping the up-to-date check.";

/** Every fact the check reads, with the values of a repo in step. */
const CURRENT: UpToDateFacts = {
  isRepo: true,
  hasOrigin: true,
  branch: "master",
  fetchOk: true,
  behind: 0,
  terminal: false,
};

function facts(changes: Partial<UpToDateFacts>): UpToDateFacts {
  return { ...CURRENT, ...changes };
}

describe("upToDateAction", () => {
  test("a folder that is not a git repo: no check, no message", () => {
    expect(upToDateAction(facts({ isRepo: false }))).toEqual({ kind: "none" });
  });

  test("a repo with no origin remote: no check, no message", () => {
    expect(upToDateAction(facts({ hasOrigin: false }))).toEqual({
      kind: "none",
    });
  });

  test("a branch other than master: no check, no message", () => {
    expect(upToDateAction(facts({ branch: "engine/front-door" }))).toEqual({
      kind: "none",
    });
  });

  test("a detached HEAD: no check, no message", () => {
    expect(upToDateAction(facts({ branch: undefined }))).toEqual({
      kind: "none",
    });
  });

  test("a fetch that fails: the note, even when behind is known", () => {
    expect(upToDateAction(facts({ fetchOk: false, behind: 2 }))).toEqual({
      kind: "note",
      line: NOTE,
    });
  });

  test("up to date: no message", () => {
    expect(upToDateAction(facts({ behind: 0 }))).toEqual({ kind: "none" });
  });

  test("behind without a terminal: the warning and the run goes on", () => {
    expect(upToDateAction(facts({ behind: 1 }))).toEqual({
      kind: "warning",
      line: "  WARNING: repo is 1 commit(s) behind origin/master; run git pull --ff-only.",
    });
  });

  test("behind with a terminal: the question, with the count", () => {
    expect(upToDateAction(facts({ behind: 3, terminal: true }))).toEqual({
      kind: "ask",
      prompt:
        "  Repo is 3 commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n] ",
      behind: 3,
    });
  });

  test("a field that cannot tell a count (0) counts as up to date", () => {
    expect(upToDateAction(facts({ behind: 0, terminal: true }))).toEqual({
      kind: "none",
    });
  });
});

describe("pulledLine", () => {
  test("names the count just pulled", () => {
    expect(pulledLine(2)).toBe("  Pulled 2 commit(s); run the command again.");
  });

  test("the pull failure line", () => {
    expect(PULL_FAILED).toBe("ERROR: pull failed; resolve it and rerun.");
  });
});
