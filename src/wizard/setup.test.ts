import { describe, expect, test } from "bun:test";
import type { Scan } from "../adapters/scan.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import type { SetupFlags, SetupInput, SetupOutcome } from "./setup.ts";
import { runSetup } from "./setup.ts";

const TODAY = "2026-11-13";

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: {
    shell: { description: "Shell" },
    git: { description: "Git" },
    gh: { description: "GitHub CLI" },
    vscode: { description: "VS Code" },
    claude: { description: "Claude" },
    "claude-worker": { description: "Worker" },
    gnome: { description: "GNOME", os: ["linux"] },
    "windows-terminal": { description: "Terminal", os: ["windows"] },
  },
  entries: [],
};

function scan(overrides: Partial<Scan> = {}): Scan {
  return {
    os: "linux",
    hostname: "wk1-laptop",
    domain: null,
    gitEmail: null,
    tools: {
      found: ["git", "gh", "claude"],
      missing: ["jq", "code", "tmux", "starship", "wezterm", "htop", "rtk"],
    },
    files: { existing: 0, total: 2 },
    ...overrides,
  };
}

function profile(
  name: string,
  modules: readonly string[] = ["shell", "git"],
): Profile {
  return { name, modules, values: {}, destinations: {}, retired: false };
}

function record(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    name: "wk1-laptop",
    profile: "work-1",
    os: "linux",
    hostname: "wk1-laptop",
    domain: null,
    claude: "claude",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: {},
    replaced: [],
    retired: false,
    ...overrides,
  };
}

function input(
  overrides: Partial<SetupInput> = {},
  flags: SetupFlags = {},
): SetupInput {
  return {
    scan: scan(),
    config: CONFIG,
    profiles: [],
    records: [],
    isPrivate: false,
    today: TODAY,
    flags,
    ...overrides,
  };
}

/** A scripted terminal: answers in order, then end of input. */
async function run(
  setup: SetupInput,
  answers: readonly string[] = [],
): Promise<{ outcome: SetupOutcome; output: string }> {
  let output = "";
  const queue = [...answers];
  const outcome = await runSetup(setup, {
    write: (text) => {
      output += text;
    },
    readLine: async () => queue.shift(),
  });
  return { outcome, output };
}

const SCAN_BLOCK = [
  "Scanning this machine...",
  "  OS         linux",
  "  Hostname   wk1-laptop",
  "  Domain     none",
  "  Git email  none",
  "  Tools      git, gh, claude (not found: jq, code, tmux, starship, wezterm, htop, rtk)",
  "  Files      0 of 2 linux entries already exist here",
  "",
].join("\n");

const Q1 = "1/4 What is this machine for? ";
const Q2 =
  "2/4 Claude here? 1) none  2) Claude only  3) Claude plus DeepSeek [2] ";
const Q3 =
  "3/4 Push with a preview, or pull only? 1) push with a preview  2) pull only [1] ";
const Q4 =
  "4/4 Files that are already here? 1) back up and replace  2) keep mine, push them first  3) stop [1] ";

describe("runSetup", () => {
  test("should print the contract's layout for answers on stdin", async () => {
    const { outcome, output } = await run(input(), ["work-1", "2", "1", "1"]);
    expect(output).toBe(
      [
        SCAN_BLOCK,
        "Profiles on this machine:",
        "  1) personal",
        "",
        `${Q1}${Q2}${Q3}${Q4}`,
        "Machine wk1-laptop: profile work-1, Claude only, push with a preview.",
        "Same as: mksync setup --profile work-1 --name wk1-laptop --claude claude --mode push --existing backup",
        "",
      ].join("\n"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.action).toBe("backup");
    expect(outcome.newProfile).toBe(true);
    expect(outcome.replaced).toBe(false);
    expect(outcome.profile).toEqual(
      profile("work-1", ["shell", "git", "gh", "claude", "gnome"]),
    );
    expect(outcome.record).toEqual(record());
  });

  test("should take every flag and ask nothing", async () => {
    const { outcome, output } = await run(
      input(
        {},
        {
          name: "wk1-laptop",
          profile: "work-1",
          claude: "claude-deepseek",
          mode: "push",
          existing: "keep",
          yes: true,
        },
      ),
    );
    expect(output).not.toContain("1/4");
    expect(output).toContain(
      "Same as: mksync setup --profile work-1 --name wk1-laptop --claude claude-deepseek --mode push --existing keep\n",
    );
    expect(output).toContain(
      "Machine wk1-laptop: profile work-1, Claude plus DeepSeek, push with a preview.\n",
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.action).toBe("keep");
    expect(outcome.record.pullOnly).toBe(false);
    expect(outcome.record.claude).toBe("claude-deepseek");
    expect(outcome.profile.modules).toEqual([
      "shell",
      "git",
      "gh",
      "claude",
      "claude-worker",
      "gnome",
    ]);
  });

  test("should take each suggestion on --yes", async () => {
    const { outcome } = await run(input({}, { profile: "work-1", yes: true }));
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.claude).toBe("claude");
    expect(outcome.record.pullOnly).toBe(false);
    expect(outcome.action).toBe("backup");
  });

  test("should suggest no Claude when the scan didn't find it", async () => {
    const noClaude = scan({
      tools: { found: ["git"], missing: ["gh", "claude"] },
    });
    const { outcome, output } = await run(
      input({ scan: noClaude }, { profile: "work-1", yes: true }),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.claude).toBe("none");
    expect(output).toContain("profile work-1, none, push with a preview.");
  });

  test("should take the suggestion on an empty answer and at end of input", async () => {
    const { outcome } = await run(input(), ["work-1", ""]);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.claude).toBe("claude");
    expect(outcome.action).toBe("backup");
  });

  test("should stop with missing --profile when there is no suggestion", async () => {
    const yes = await run(input({}, { yes: true }));
    expect(yes.outcome).toEqual({
      ok: false,
      message: "ERROR: missing --profile",
      code: 2,
    });
    expect(yes.output).toBe(
      `${SCAN_BLOCK}\nProfiles on this machine:\n  1) personal\n\n`,
    );
    const eof = await run(input());
    expect(eof.outcome).toEqual({
      ok: false,
      message: "ERROR: missing --profile",
      code: 2,
    });
  });

  test("should ask the first question again after a bad answer", async () => {
    const { outcome, output } = await run(input(), ["7", "Bad_Name", "1"]);
    expect(output).toContain(
      `${Q1}Pick 1 to 1 or type a new profile name.\n${Q1}Pick 1 to 1 or type a new profile name.\n${Q1}`,
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.name).toBe("personal");
  });

  test("should ask a numbered question again after a bad answer", async () => {
    const { outcome, output } = await run(input({}, { profile: "work-1" }), [
      "9",
      "3",
    ]);
    expect(output).toContain(`${Q2}Pick 1 to 3.\n${Q2}`);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.claude).toBe("claude-deepseek");
  });

  test("should ask a question again for a hex or decimal number answer", async () => {
    const { outcome, output } = await run(input({}, { profile: "work-1" }), [
      "0x2",
      "2.0",
      "3",
    ]);
    expect(output).toContain(
      `${Q2}Pick 1 to 3.\n${Q2}Pick 1 to 3.\n${Q2}`,
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.claude).toBe("claude-deepseek");
  });

  test("should refuse a machine name equal to the profile flag", async () => {
    const { outcome, output } = await run(
      input({ scan: scan({ hostname: "work-1" }) }, { profile: "work-1" }),
    );
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: machine work-1 can't share its profile's name; use --name <machine>.",
      code: 2,
    });
    expect(output.endsWith("Profiles on this machine:\n  1) personal\n\n")).toBe(
      true,
    );
    expect(output).not.toContain("1/4");
    expect(output).not.toContain("Machine ");
  });

  test("should refuse a machine name equal to the profile typed at the first question", async () => {
    const { outcome, output } = await run(input(), ["wk1-laptop"]);
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: machine wk1-laptop can't share its profile's name; use --name <machine>.",
      code: 2,
    });
    expect(output).toBe(
      `${SCAN_BLOCK}\nProfiles on this machine:\n  1) personal\n\n${Q1}\n`,
    );
    expect(output).not.toContain("2/4");
  });

  test("should pick a listed profile by number and keep its modules", async () => {
    const work = profile("work-1", ["git"]);
    const { outcome, output } = await run(input({ profiles: [work] }), ["2"]);
    expect(output).toContain("  1) personal\n  2) work-1\n");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.newProfile).toBe(false);
    expect(outcome.profile).toEqual(work);
  });

  test("should list a retired profile's machines but not the profile itself", async () => {
    const setup = input({
      profiles: [profile("work-1"), { ...profile("work-2"), retired: true }],
      records: [
        record({ name: "wk1-desk", hostname: "wk1-desk" }),
        record({ name: "wk1-old", retired: true }),
      ],
    });
    const { output } = await run(setup, ["1"]);
    expect(output).toContain(
      "  1) personal\n  2) work-1      machine wk1-desk\n\n",
    );
  });

  test("should refuse a retired profile named by --profile", async () => {
    const retired = { ...profile("work-1"), retired: true };
    const { outcome, output } = await run(
      input(
        { profiles: [retired] },
        {
          profile: "work-1",
          claude: "claude",
          mode: "push",
          existing: "backup",
          yes: true,
        },
      ),
    );
    expect(outcome).toEqual({
      ok: false,
      message: "ERROR: profile work-1 is retired; pick another name.",
      code: 1,
    });
    expect(output).toBe(
      `${SCAN_BLOCK}\nProfiles on this machine:\n  1) personal\n\n`,
    );
    expect(output).not.toContain("Machine ");
  });

  test("should refuse a retired profile typed at the first question", async () => {
    const setup = input({
      profiles: [{ ...profile("work-1"), retired: true }],
    });
    const { outcome, output } = await run(setup, ["work-1"]);
    expect(outcome).toEqual({
      ok: false,
      message: "ERROR: profile work-1 is retired; pick another name.",
      code: 1,
    });
    expect(output).toBe(
      `${SCAN_BLOCK}\nProfiles on this machine:\n  1) personal\n\n${Q1}\n`,
    );
    expect(output).not.toContain("2/4");
  });

  test("should suggest the profile of the record with this hostname once private", async () => {
    const setup = input({
      profiles: [profile("work-1")],
      records: [record()],
      isPrivate: true,
    });
    const { outcome, output } = await run(setup, ["", ""]);
    expect(output).toContain(
      "Profiles in this repo:\n  1) personal\n  2) work-1      machine wk1-laptop\n" +
        "  This looks like wk1-laptop (same hostname): choosing 2 replaces it.\n\n" +
        `1/4 What is this machine for? [2] ${Q4}\n`,
    );
    expect(output).toContain(
      "Same as: mksync setup --profile work-1 --replace wk1-laptop --claude claude --mode push --existing backup\n",
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record).toEqual(record());
    expect(outcome.replaced).toBe(true);
  });

  test("should not suggest while public", async () => {
    const setup = input({ profiles: [profile("work-1")], records: [record()] });
    const { output } = await run(setup, ["2"]);
    expect(output).not.toContain("This looks like");
    expect(output).toContain(`${Q1}${Q2}`);
  });

  test("should replace a record from --replace, keeping its answers", async () => {
    const old = record({
      hostname: "wk1-old",
      claude: "none",
      pullOnly: true,
      modules: { add: ["gh"], remove: [] },
    });
    const setup = input(
      { profiles: [profile("work-1")], records: [old], isPrivate: true },
      {
        replace: "wk1-laptop",
        existing: "stop",
      },
    );
    const { outcome, output } = await run(setup);
    expect(output).not.toContain("1/4");
    expect(output).toContain(
      "Same as: mksync setup --profile work-1 --replace wk1-laptop --claude none --mode pull-only --existing stop\n",
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record).toEqual({
      ...old,
      hostname: "wk1-laptop",
      replaced: [{ hostname: "wk1-old", domain: null, date: TODAY }],
    });
    expect(outcome.replaced).toBe(true);
  });

  test("should refuse keep with a pull-only mode given by flags", async () => {
    const { outcome, output } = await run(
      input(
        {},
        {
          profile: "work-1",
          claude: "claude",
          mode: "pull-only",
          existing: "keep",
        },
      ),
    );
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: --existing keep pushes first, so it can't be used with --mode pull-only.",
      code: 1,
    });
    expect(output).toBe(
      `${SCAN_BLOCK}\nProfiles on this machine:\n  1) personal\n\n`,
    );
    expect(output).not.toContain("Machine ");
  });

  test("should refuse keep answered after pull-only", async () => {
    const { outcome, output } = await run(
      input({}, { profile: "work-1", claude: "claude" }),
      ["2", "2"],
    );
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: --existing keep pushes first, so it can't be used with --mode pull-only.",
      code: 1,
    });
    expect(output).toBe(
      `${SCAN_BLOCK}\nProfiles on this machine:\n  1) personal\n\n${Q3}${Q4}\n`,
    );
    expect(output).not.toContain("Machine ");
  });

  test("should refuse --replace of a missing or retired record", async () => {
    const missing = await run(input({}, { replace: "wk1-laptop" }));
    const message =
      "ERROR: no machine wk1-laptop here; records are shared once the repo is private.";
    expect(missing.outcome).toEqual({ ok: false, message, code: 1 });
    expect(missing.output).toBe("");
    const retired = await run(
      input(
        { records: [record({ retired: true })] },
        { replace: "wk1-laptop" },
      ),
    );
    expect(retired.outcome).toEqual({ ok: false, message, code: 1 });
  });

  test("should refuse --name with --replace", async () => {
    const { outcome, output } = await run(
      input({}, { name: "a", replace: "wk1-laptop" }),
    );
    expect(outcome).toEqual({
      ok: false,
      message: "ERROR: --name and --replace can't be used together.",
      code: 1,
    });
    expect(output).toBe("");
  });

  test("should refuse a machine that already has a record", async () => {
    const { outcome, output } = await run(
      input({ own: record() }, { profile: "work-1", yes: true }),
    );
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: this machine is already wk1-laptop; use --replace to take over another record.",
      code: 1,
    });
    expect(output).toBe("");
  });

  test("should refuse an invalid machine or profile name", async () => {
    const name = await run(
      input({ scan: scan({ hostname: "wk1_laptop" }) }, { profile: "work-1" }),
    );
    expect(name.outcome).toEqual({
      ok: false,
      message:
        "ERROR: wk1_laptop isn't a valid machine name; use --name <machine>.",
      code: 2,
    });
    expect(name.output).toBe("");
    const flag = await run(input({}, { profile: "Work" }));
    expect(flag.outcome).toEqual({
      ok: false,
      message: "ERROR: Work isn't a valid profile name; use --profile <name>.",
      code: 2,
    });
  });

  test("should give a new profile windows-terminal on Windows and vscode for code", async () => {
    const windows = scan({
      os: "windows",
      tools: { found: ["code"], missing: [] },
    });
    const { outcome } = await run(
      input({ scan: windows }, { profile: "work-1", yes: true }),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.modules).toEqual([
      "shell",
      "git",
      "vscode",
      "windows-terminal",
    ]);
    expect(outcome.record.os).toBe("windows");
  });
});
