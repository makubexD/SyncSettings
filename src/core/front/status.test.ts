import { describe, expect, test } from "bun:test";
import { nextCommand, statusLines } from "./status.ts";
import type {
  DiffSplit,
  MachineFact,
  OriginFact,
  StatusFacts,
} from "./status.ts";

const REPO = "/home/me/SyncSettings";

const OS_NAME = "Ubuntu 24.04";

const DOCTOR = "run mksync doctor.";

const TAKE_REPO_OR_SEND =
  "mksync pull to take the repo's version, or mksync push to send this machine's.";

const FILE_BY_FILE = "mksync diff, then push or pull file by file.";

const FORCE_PULL =
  "mksync pull --force to take the repo's version (each keeps a .bak).";

const MACHINE_UNKNOWN =
  "the machine check failed; run mksync check to see why.";

/** Every fact, with the values of an up-to-date clone on this machine. */
const CURRENT: StatusFacts = {
  os: "linux",
  osName: OS_NAME,
  repo: REPO,
  origin: { kind: "fetched", updates: 0 },
  unsent: 0,
  machine: { kind: "match" },
  pullOnly: false,
  linked: [],
};

function facts(changes: Partial<StatusFacts>): StatusFacts {
  return { ...CURRENT, ...changes };
}

/** A diff split whose summary matches its counts. */
function split(inCount: number, outCount: number, bothCount: number): DiffSplit {
  const total = inCount + outCount + bothCount;
  return {
    summary: `${total} file(s) differ: ${inCount} in, ${outCount} out, ${bothCount} both`,
    in: inCount,
    out: outCount,
    both: bothCount,
  };
}

function differ(diff: DiffSplit | null): MachineFact {
  return { kind: "differ", count: diff === null ? 2 : diff.in + diff.out + diff.both, diff };
}

/** The line with a given label, so a test reads only the text it checks. */
function labelledLine(f: StatusFacts, label: string): string {
  const prefix = `  ${label.padEnd(10)}: `;
  const line = statusLines(f).find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`no ${label} line`);
  }
  return line;
}

describe("nextCommand", () => {
  test("rule 1: not a git clone suggests doctor", () => {
    expect(nextCommand(facts({ origin: { kind: "not-git" } }))).toBe(DOCTOR);
  });

  test("rule 1: no origin remote suggests doctor", () => {
    expect(nextCommand(facts({ origin: { kind: "no-origin" } }))).toBe(DOCTOR);
  });

  test("rule 2: origin updates win over unsent changes and a differing machine", () => {
    const f = facts({
      origin: { kind: "fetched", updates: 2 },
      unsent: 1,
      machine: differ(null),
    });

    expect(nextCommand(f)).toBe("mksync pull");
  });

  test("rule 3: unsent changes suggest push over a differing machine", () => {
    expect(nextCommand(facts({ unsent: 3, machine: differ(null) }))).toBe(
      "mksync push",
    );
  });

  test("rule 3: a pull-only machine skips the push rule", () => {
    expect(nextCommand(facts({ unsent: 3, pullOnly: true }))).toBe(
      "nothing to do.",
    );
  });

  test("rule 4: a differing machine with no sync point takes either side", () => {
    expect(nextCommand(facts({ machine: differ(null) }))).toBe(
      TAKE_REPO_OR_SEND,
    );
  });

  test("rule 5: an unknown machine check names the check", () => {
    expect(nextCommand(facts({ machine: { kind: "unknown" } }))).toBe(
      MACHINE_UNKNOWN,
    );
  });

  test("rule 6: nothing to send, fetch or apply", () => {
    expect(nextCommand(facts({}))).toBe("nothing to do.");
  });
});

describe("nextCommand on a differing machine, not pull-only", () => {
  test("no diff: takes the repo's version or sends this machine's", () => {
    expect(nextCommand(facts({ machine: differ(null) }))).toBe(
      TAKE_REPO_OR_SEND,
    );
  });

  test("changed on both sides: diff, then push or pull file by file", () => {
    expect(nextCommand(facts({ machine: differ(split(1, 1, 0)) }))).toBe(
      FILE_BY_FILE,
    );
  });

  test("BOTH: diff, then push or pull file by file", () => {
    expect(nextCommand(facts({ machine: differ(split(0, 0, 2)) }))).toBe(
      FILE_BY_FILE,
    );
  });

  test("OUT only: push", () => {
    expect(nextCommand(facts({ machine: differ(split(0, 2, 0)) }))).toBe(
      "mksync push",
    );
  });

  test("IN only: pull", () => {
    expect(nextCommand(facts({ machine: differ(split(2, 0, 0)) }))).toBe(
      "mksync pull",
    );
  });

  test("a diff that agrees: takes the repo's version or sends this machine's", () => {
    expect(nextCommand(facts({ machine: differ(split(0, 0, 0)) }))).toBe(
      TAKE_REPO_OR_SEND,
    );
  });
});

describe("nextCommand on a differing machine, pull-only", () => {
  test("OUT: forced pull, each file keeps a .bak", () => {
    expect(
      nextCommand(facts({ pullOnly: true, machine: differ(split(0, 1, 0)) })),
    ).toBe(FORCE_PULL);
  });

  test("BOTH: forced pull, each file keeps a .bak", () => {
    expect(
      nextCommand(facts({ pullOnly: true, machine: differ(split(0, 0, 1)) })),
    ).toBe(FORCE_PULL);
  });

  test("IN only: a plain pull", () => {
    expect(
      nextCommand(facts({ pullOnly: true, machine: differ(split(1, 0, 0)) })),
    ).toBe("mksync pull");
  });

  test("a diff that agrees: a plain pull", () => {
    expect(
      nextCommand(facts({ pullOnly: true, machine: differ(split(0, 0, 0)) })),
    ).toBe("mksync pull");
  });

  test("no diff: a plain pull", () => {
    expect(nextCommand(facts({ pullOnly: true, machine: differ(null) }))).toBe(
      "mksync pull",
    );
  });
});

describe("statusLines origin text", () => {
  const NOT_GIT: OriginFact = { kind: "not-git" };
  const NO_ORIGIN: OriginFact = { kind: "no-origin" };

  test("not a git clone", () => {
    expect(labelledLine(facts({ origin: NOT_GIT }), "Origin")).toBe(
      "  Origin    : not a git clone",
    );
  });

  test("no origin remote", () => {
    expect(labelledLine(facts({ origin: NO_ORIGIN }), "Origin")).toBe(
      "  Origin    : no origin remote",
    );
  });

  test("a branch other than master", () => {
    const origin: OriginFact = { kind: "branch", branch: "engine/front-door" };

    expect(labelledLine(facts({ origin }), "Origin")).toBe(
      "  Origin    : on branch engine/front-door, not master",
    );
  });

  test("a failed fetch", () => {
    expect(labelledLine(facts({ origin: { kind: "offline" } }), "Origin")).toBe(
      "  Origin    : offline, not checked",
    );
  });

  test("updates waiting", () => {
    const origin: OriginFact = { kind: "fetched", updates: 2 };

    expect(labelledLine(facts({ origin }), "Origin")).toBe(
      "  Origin    : 2 update(s) waiting",
    );
  });

  test("up to date", () => {
    expect(labelledLine(facts({}), "Origin")).toBe("  Origin    : up to date");
  });
});

describe("statusLines unsent text", () => {
  test("not checked outside a git clone", () => {
    expect(labelledLine(facts({ unsent: null }), "Unsent")).toBe(
      "  Unsent    : not checked",
    );
  });

  test("changed files not sent yet", () => {
    expect(labelledLine(facts({ unsent: 3 }), "Unsent")).toBe(
      "  Unsent    : 3 changed file(s) not sent yet",
    );
  });

  test("none", () => {
    expect(labelledLine(facts({ unsent: 0 }), "Unsent")).toBe(
      "  Unsent    : none",
    );
  });
});

describe("statusLines machine text", () => {
  test("unknown names the check", () => {
    expect(labelledLine(facts({ machine: { kind: "unknown" } }), "Machine")).toBe(
      "  Machine   : not checked: run mksync check to see why",
    );
  });

  test("matches the repo", () => {
    expect(labelledLine(facts({ machine: { kind: "match" } }), "Machine")).toBe(
      "  Machine   : matches the repo",
    );
  });

  test("differing files give the diff's summary", () => {
    expect(
      labelledLine(facts({ machine: differ(split(1, 1, 0)) }), "Machine"),
    ).toBe("  Machine   : 2 file(s) differ: 1 in, 1 out, 0 both");
  });

  test("differing files with no diff give the count", () => {
    expect(labelledLine(facts({ machine: differ(null) }), "Machine")).toBe(
      "  Machine   : 2 file(s) differ from the repo",
    );
  });
});

describe("statusLines", () => {
  test("prints the header, the facts, the linked folders and the next step", () => {
    const f = facts({
      origin: { kind: "fetched", updates: 2 },
      unsent: 1,
      machine: differ(split(1, 1, 0)),
      linked: ["Linked folder not synced: ~/.config/app (mksync setup asks)"],
    });

    expect(statusLines(f)).toEqual([
      "",
      "  SyncSettings  linux (Ubuntu 24.04)",
      "  Repo      : /home/me/SyncSettings",
      "  Origin    : 2 update(s) waiting",
      "  Unsent    : 1 changed file(s) not sent yet",
      "  Machine   : 2 file(s) differ: 1 in, 1 out, 0 both",
      "  Linked folder not synced: ~/.config/app (mksync setup asks)",
      "",
      "  Next: mksync pull",
    ]);
  });

  test("a linked line follows Machine and precedes the blank line", () => {
    const lines = statusLines(
      facts({ linked: ["Linked folder not synced: ~/.config/app (mksync setup asks)"] }),
    );
    const machine = lines.indexOf("  Machine   : matches the repo");
    const blank = lines.indexOf("", machine);
    const next = lines.indexOf("  Next: nothing to do.");

    expect(lines[machine + 1]).toBe(
      "  Linked folder not synced: ~/.config/app (mksync setup asks)",
    );
    expect(blank).toBe(machine + 2);
    expect(next).toBe(blank + 1);
  });
});
