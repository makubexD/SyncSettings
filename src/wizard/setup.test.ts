import { describe, expect, test } from "bun:test";
import type { Scan } from "../adapters/scan.ts";
import type { LinkedFolder } from "../adapters/store.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, ConfigV2Entry } from "../core/config/types.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import type {
  SetupDiffer,
  SetupFlags,
  SetupInput,
  SetupOutcome,
} from "./setup.ts";
import { guessProfile, runSetup } from "./setup.ts";

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
    differ: differ(),
    ...overrides,
  };
}

function differ(overrides: Partial<SetupDiffer> = {}): SetupDiffer {
  return { updates: 0, hasSyncPoint: false, ...overrides };
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
const GUESS_PERSONAL = "Guess: personal (Linux, no domain).";
const Q1_PERSONAL = `${Q1}[1] `;
const LABEL_QUESTION = (profileName: string): string =>
  ` Label for ${profileName}, to find it in lists (optional): `;
const Q2 =
  "2/4 Claude here? 1) none  2) Claude only  3) Claude plus DeepSeek [2] ";
const Q3 =
  "3/4 Push with a preview, or pull only? 1) push with a preview  2) pull only [1] ";
const Q4 =
  "4/4 Files that are already here? 1) back up and replace  2) keep mine, push them first  3) stop [1] ";
const BOOTSTRAP_QUESTION =
  "  Also restore apps and packages from packages/linux (uses sudo)? [y/N] ";
const CONFIRM_QUESTION = "Write the record and apply? [Y/n] ";
const CONFIRM_STOP_QUESTION = "Write the record? [Y/n] ";

/** The four flags that answer every question, without `--yes`. */
const ANSWER_FLAGS: SetupFlags = {
  profile: "work-1",
  claude: "claude",
  mode: "push",
  existing: "backup",
};

const OUT_LINE = "  OUT        dotfiles/common/shell/a.conf";

const BOTH_LINE = "  BOTH       dotfiles/common/shell/b.conf";

/** A sync-point diff that blocks: one `OUT` file. */
const OUT_DIFF = {
  ok: true,
  inCount: 0,
  outCount: 1,
  bothCount: 0,
  blocked: [OUT_LINE],
} as const;

describe("runSetup", () => {
  test("should print the contract's layout for answers on stdin", async () => {
    const { outcome, output } = await run(input(), [
      "work-1",
      "",
      "2",
      "1",
      "1",
      "",
    ]);
    expect(output).toBe(
      [
        SCAN_BLOCK,
        GUESS_PERSONAL,
        "",
        "Profiles on this machine:",
        "  1) personal",
        "",
        `${Q1_PERSONAL}${LABEL_QUESTION("work-1")}${Q2}${Q3}${Q4}`,
        "Machine wk1-laptop: profile work-1, Claude only, push with a preview.",
        "Public name: work-1-linux",
        "Same as: mksync setup --profile work-1 --name wk1-laptop --claude claude --mode push --existing backup --alias work-1-linux",
        "Write the record and apply? [Y/n] ",
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
    expect(outcome.record).toEqual(record({ alias: "work-1-linux" }));
  });

  test("should go on when the confirm is answered yes", async () => {
    // Arrange
    const setup = input({}, ANSWER_FLAGS);

    // Act
    const { outcome, output } = await run(setup, ["y"]);

    // Assert
    expect(outcome.ok).toBe(true);
    expect(output).toContain("Write the record and apply? [Y/n] ");
  });

  test("should write nothing when the confirm is answered no", async () => {
    // Arrange
    const setup = input({}, ANSWER_FLAGS);

    // Act
    const { outcome, output } = await run(setup, ["n"]);

    // Assert
    expect(outcome).toEqual({ ok: false, declined: true });
    expect(output.endsWith(CONFIRM_QUESTION)).toBe(true);
  });

  test("should take end of input on the confirm as no", async () => {
    // Arrange
    const setup = input({}, ANSWER_FLAGS);

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    expect(outcome).toEqual({ ok: false, declined: true });
    expect(output.endsWith(CONFIRM_QUESTION)).toBe(true);
  });

  test("should take an empty line on the confirm as yes", async () => {
    // Arrange
    const setup = input({}, ANSWER_FLAGS);

    // Act
    const { outcome } = await run(setup, [""]);

    // Assert
    expect(outcome.ok).toBe(true);
  });

  test("should take --yes without reading the confirm", async () => {
    // Arrange
    const setup = input({}, { ...ANSWER_FLAGS, yes: true });

    // Act
    // With no scripted answers a read would now mean end of input, hence no.
    const { outcome, output } = await run(setup);

    // Assert
    expect(outcome.ok).toBe(true);
    expect(output).not.toContain("Write the record and apply?");
  });

  test("should ask Write the record? when the answer is stop", async () => {
    // Arrange
    const setup = input({}, { ...ANSWER_FLAGS, existing: "stop" });

    // Act
    const { outcome, output } = await run(setup, [""]);

    // Assert
    expect(outcome.ok).toBe(true);
    expect(output.endsWith(CONFIRM_STOP_QUESTION)).toBe(true);
    expect(output).not.toContain(CONFIRM_QUESTION);
  });

  test("should ask Write the record? and choose no bootstrap when stop comes with --bootstrap", async () => {
    // Arrange
    const setup = input(
      { bootstrapOffered: true },
      { ...ANSWER_FLAGS, existing: "stop", bootstrap: true },
    );

    // Act
    const { outcome, output } = await run(setup, [""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
    expect(output.endsWith(CONFIRM_STOP_QUESTION)).toBe(true);
  });

  test("should ask the bootstrap question before the summary", async () => {
    // Arrange
    const setup = input({ bootstrapOffered: true }, { ...ANSWER_FLAGS });

    // Act
    const { outcome, output } = await run(setup, ["y", ""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(true);
    expect(output.indexOf(BOOTSTRAP_QUESTION)).toBeGreaterThan(-1);
    expect(output.indexOf(BOOTSTRAP_QUESTION)).toBeLessThan(
      output.indexOf("Machine "),
    );
    expect(output).toContain("--alias work-1-linux --bootstrap\n");
  });

  test("should not ask the bootstrap question with --bootstrap", async () => {
    // Arrange
    const setup = input(
      { bootstrapOffered: true },
      { ...ANSWER_FLAGS, yes: true, bootstrap: true },
    );

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(true);
    expect(output).not.toContain("Also restore apps and packages");
    expect(output).toContain(
      "Same as: mksync setup --profile work-1 --name wk1-laptop --claude claude --mode push --existing backup --alias work-1-linux --bootstrap\n",
    );
  });

  test("should not ask the bootstrap question with --no-bootstrap", async () => {
    const setup = input(
      { bootstrapOffered: true },
      { ...ANSWER_FLAGS, yes: true, noBootstrap: true },
    );

    const { outcome, output } = await run(setup);

    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
    expect(output).not.toContain("Also restore apps and packages");
    expect(output).toContain("--alias work-1-linux --no-bootstrap\n");
  });

  test("should skip the bootstrap under --yes alone without reading stdin", async () => {
    const setup = input(
      { bootstrapOffered: true },
      { ...ANSWER_FLAGS, yes: true },
    );

    const { outcome, output } = await run(setup, ["y"]);

    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
    expect(output).not.toContain("Also restore apps and packages");
    expect(output).toContain("--alias work-1-linux --no-bootstrap\n");
  });

  test("should print --no-bootstrap when the question was answered no", async () => {
    const setup = input({ bootstrapOffered: true }, { ...ANSWER_FLAGS });

    const { outcome, output } = await run(setup, ["n", ""]);

    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
    expect(output).toContain("--alias work-1-linux --no-bootstrap\n");
  });

  test("should print no bootstrap flag when the bootstrap was not offered", async () => {
    const setup = input({}, { ...ANSWER_FLAGS, yes: true, noBootstrap: true });

    const { outcome, output } = await run(setup);

    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
    expect(output).not.toContain("bootstrap");
  });

  test("should not ask the bootstrap question for the stop answer", async () => {
    // Arrange
    const setup = input(
      { bootstrapOffered: true },
      { ...ANSWER_FLAGS, existing: "stop", yes: true },
    );

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
    expect(output).not.toContain("Also restore apps and packages");
    expect(output).not.toContain("--bootstrap");
  });

  test("should not choose the bootstrap when --bootstrap meets the stop answer", async () => {
    // Arrange
    const setup = input(
      { bootstrapOffered: true },
      { ...ANSWER_FLAGS, existing: "stop", yes: true, bootstrap: true },
    );

    // Act
    const { outcome } = await run(setup);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.bootstrap).toBe(false);
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
      "Same as: mksync setup --profile work-1 --name wk1-laptop --claude claude-deepseek --mode push --existing keep --alias work-1-linux\n",
    );
    expect(output).toContain(
      "Machine wk1-laptop: profile work-1, Claude plus DeepSeek, push with a preview.\nPublic name: work-1-linux\n",
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
    const { outcome } = await run(input(), ["work-1", "", "", "", "", ""]);
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
      `${SCAN_BLOCK}\n${GUESS_PERSONAL}\n\nProfiles on this machine:\n  1) personal\n\n`,
    );
  });

  test("should take the guess at end of input on question 1", async () => {
    const { outcome } = await run(input(), ["", "", "", "", "y"]);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.name).toBe("personal");
  });

  test("should suggest a new work profile by name and ask its label", async () => {
    const setup = input({
      scan: scan({ domain: "corp.example" }),
      profiles: [profile("work-3")],
    });
    const { outcome, output } = await run(setup, ["", "", "", "", "", "y"]);
    expect(output).toContain(
      "Guess: new profile work4 (Linux, joined to a domain); other machines' profiles can't be seen while the repo is public, so check the number\n\n",
    );
    expect(output).toContain(`${Q1}[work4] ${LABEL_QUESTION("work4")}${Q2}`);
    expect(output).not.toContain("corp.example\n\nProfiles");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.name).toBe("work4");
    expect(outcome.newProfile).toBe(true);
  });

  test("should take a private work guess under --yes", async () => {
    const setup = input(
      {
        scan: scan({ domain: "corp.example" }),
        profiles: [profile("work1"), { ...profile("work2"), retired: true }],
        isPrivate: true,
      },
      { yes: true },
    );
    const { outcome, output } = await run(setup);
    expect(output).toContain(
      "Guess: new profile work3 (Linux, joined to a domain).\n\n",
    );
    expect(output).not.toContain(Q1);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.name).toBe("work3");
  });

  test("should stop under --yes when the work guess is public", async () => {
    const setup = input(
      { scan: scan({ domain: "corp.example" }) },
      { yes: true },
    );
    const { outcome } = await run(setup);
    expect(outcome).toEqual({
      ok: false,
      message: "ERROR: missing --profile",
      code: 2,
    });
  });

  test("should print no guess when --profile decides", async () => {
    const { output } = await run(input({}, { profile: "work-1" }), []);
    expect(output).not.toContain("Guess:");
  });

  test("should ask the first question again after a bad answer", async () => {
    const { outcome, output } = await run(input(), [
      "7",
      "Bad_Name",
      "1",
      "",
      "",
      "",
      "",
    ]);
    expect(output).toContain(
      `${Q1_PERSONAL}Pick 1 to 1 or type a new profile name.\n${Q1_PERSONAL}Pick 1 to 1 or type a new profile name.\n${Q1_PERSONAL}`,
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.name).toBe("personal");
  });

  test("should ask a numbered question again after a bad answer", async () => {
    const { outcome, output } = await run(input({}, { profile: "work-1" }), [
      "9",
      "3",
      "",
      "",
      "",
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
      "",
      "",
      "",
    ]);
    expect(output).toContain(`${Q2}Pick 1 to 3.\n${Q2}Pick 1 to 3.\n${Q2}`);
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
    expect(
      output.endsWith("Profiles on this machine:\n  1) personal\n\n"),
    ).toBe(true);
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
      `${SCAN_BLOCK}\n${GUESS_PERSONAL}\n\nProfiles on this machine:\n  1) personal\n\n${Q1_PERSONAL}\n`,
    );
    expect(output).not.toContain("2/4");
  });

  test("should pick a listed profile by number and keep its modules", async () => {
    const work = profile("work-1", ["git"]);
    const { outcome, output } = await run(input({ profiles: [work] }), [
      "2",
      "",
      "",
      "",
      "",
    ]);
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
      `${SCAN_BLOCK}\n${GUESS_PERSONAL}\n\nProfiles on this machine:\n  1) personal\n\n${Q1_PERSONAL}\n`,
    );
    expect(output).not.toContain("2/4");
  });

  test("should suggest the profile of the record with this hostname once private", async () => {
    const setup = input({
      profiles: [profile("work-1")],
      records: [record()],
      isPrivate: true,
    });
    const { outcome, output } = await run(setup, ["", "", ""]);
    expect(output).toContain(
      "Profiles in this repo:\n  1) personal\n  2) work-1      machine wk1-laptop\n" +
        "  This looks like wk1-laptop (same hostname): choosing 2 replaces it.\n\n" +
        `1/4 What is this machine for? [2] ${Q4}\n`,
    );
    expect(output).toContain(
      "Same as: mksync setup --profile work-1 --replace wk1-laptop --claude claude --mode push --existing backup --alias work-1-linux\n",
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record).toEqual(record({ alias: "work-1-linux" }));
    expect(outcome.replaced).toBe(true);
  });

  test("should not suggest while public", async () => {
    const setup = input({ profiles: [profile("work-1")], records: [record()] });
    const { output } = await run(setup, ["2"]);
    expect(output).not.toContain("This looks like");
    expect(output).toContain(`${Q1_PERSONAL}${Q2}`);
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
    const { outcome, output } = await run(setup, [""]);
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

  test("should print the differ line above question 4 with a sync point", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          diff: {
            ok: true,
            inCount: 1,
            outCount: 2,
            bothCount: 0,
            blocked: [OUT_LINE],
          },
        }),
      },
      ANSWER_FLAGS,
    );

    // Act
    const { outcome, output } = await run(setup, ["y"]);

    // Assert
    expect(outcome.ok).toBe(true);
    const line = "  3 file(s) differ: 1 in, 2 out, 0 both.";
    expect(output).toContain(`${line}\n`);
    expect(output.indexOf(line)).toBeLessThan(output.indexOf("Machine "));
  });

  test("should print the newer-side-unknown differ line without a sync point", async () => {
    // Arrange
    const setup = input({ differ: differ({ updates: 2 }) }, ANSWER_FLAGS);

    // Act
    const { output } = await run(setup);

    // Assert
    expect(output).toContain(
      "  2 file(s) differ. No sync is recorded on this machine, so the newer side is unknown.\n",
    );
  });

  test("should print the could-not-tell differ line after a failed diff", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({ hasSyncPoint: true, updates: 2, diff: { ok: false } }),
      },
      ANSWER_FLAGS,
    );

    // Act
    const { output } = await run(setup);

    // Assert
    expect(output).toContain(
      "  2 file(s) differ; could not tell which side is newer.\n",
    );
  });

  test("should print no differ line when nothing differs", async () => {
    // Arrange
    const setup = input({}, ANSWER_FLAGS);

    // Act
    const { output } = await run(setup);

    // Assert
    expect(output).not.toContain("file(s) differ");
  });

  test("should suggest keep when a push would overwrite an OUT file", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          diff: {
            ok: true,
            inCount: 0,
            outCount: 1,
            bothCount: 0,
            blocked: [OUT_LINE],
          },
        }),
      },
      { profile: "work-1", claude: "claude", mode: "push" },
    );

    // Act
    const { outcome, output } = await run(setup, ["", ""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.action).toBe("keep");
    expect(output).toContain("  3) stop [2] ");
  });

  test("should suggest back up and replace when the diff has only IN lines", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          diff: {
            ok: true,
            inCount: 1,
            outCount: 0,
            bothCount: 0,
            blocked: [],
          },
        }),
      },
      { profile: "work-1", claude: "claude", mode: "push" },
    );

    // Act
    const { output } = await run(setup, [""]);

    // Assert
    expect(output).toContain("  3) stop [1] ");
  });

  test("should print the guard block and a [y/N] confirm for backup with an OUT file", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          updates: 1,
          diff: OUT_DIFF,
        }),
      },
      ANSWER_FLAGS,
    );

    // Act
    const { outcome, output } = await run(setup, ["y"]);

    // Assert
    expect(outcome.ok).toBe(true);
    expect(output).toContain(
      `${OUT_LINE}\n  1 file(s) changed on this machine since the last sync; back up and replace overwrites them (each keeps a .bak).\n`,
    );
    expect(output).toContain("Write the record and apply? [y/N] ");
  });

  test("should take end of input on the guarded confirm as no", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          updates: 1,
          diff: OUT_DIFF,
        }),
      },
      ANSWER_FLAGS,
    );

    // Act
    const { outcome } = await run(setup);

    // Assert
    expect(outcome).toEqual({ ok: false, declined: true });
  });

  test("should refuse --yes after a guard block", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          updates: 1,
          diff: OUT_DIFF,
        }),
      },
      { ...ANSWER_FLAGS, yes: true },
    );

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: 1 file(s) changed on this machine since the last sync, and setup would overwrite them.\n" +
        "Run mksync setup --existing keep to push them first, or run it without --yes to confirm.",
      code: 1,
    });
    expect(output).toContain(
      `${OUT_LINE}\n  1 file(s) changed on this machine since the last sync; back up and replace overwrites them (each keeps a .bak).\n`,
    );
    expect(output).not.toContain("Write the record and apply?");
  });

  test("should refuse --yes after a failed diff", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({ hasSyncPoint: true, updates: 1, diff: { ok: false } }),
      },
      { ...ANSWER_FLAGS, yes: true },
    );

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: could not tell which side is newer; run mksync diff to see why, or run setup without --yes to confirm.",
      code: 1,
    });
    expect(output).toContain(
      "  Could not tell which side is newer; back up and replace may overwrite files changed here (each keeps a .bak).\n",
    );
    expect(output).not.toContain("Write the record and apply?");
  });

  test("should guard a BOTH line and count every blocked line", async () => {
    // Arrange
    const setup = input(
      {
        differ: differ({
          hasSyncPoint: true,
          updates: 2,
          diff: {
            ok: true,
            inCount: 0,
            outCount: 1,
            bothCount: 1,
            blocked: [OUT_LINE, BOTH_LINE],
          },
        }),
      },
      { ...ANSWER_FLAGS, yes: true },
    );

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: 2 file(s) changed on this machine since the last sync, and setup would overwrite them.\n" +
        "Run mksync setup --existing keep to push them first, or run it without --yes to confirm.",
      code: 1,
    });
    expect(output).toContain(
      `${OUT_LINE}\n${BOTH_LINE}\n  2 file(s) changed on this machine since the last sync; back up and replace overwrites them (each keeps a .bak).\n`,
    );
  });
});

const FLAGS_ALL: SetupFlags = {
  profile: "work-1",
  claude: "claude",
  mode: "push",
  existing: "backup",
};

const LINKED_SCRIPTS: LinkedFolder = {
  file: ".bashrc",
  path: "~/scripts",
  name: "scripts",
  module: "shell",
  count: 1,
  bytes: 40,
  suggestion: "profile",
};

const LINKED_QUESTION =
  ".bashrc uses ~/scripts (1 file, 40 B). Sync it as a folder? " +
  "1) this profile  2) this machine  3) no";

function scriptsEntry(
  localPath: string,
  file = "linked/scripts",
): ConfigV2Entry {
  return {
    file,
    module: "shell",
    merge: "dir",
    localPath,
    description: `Linked folder ${localPath}`,
  };
}

function linkedInput(
  folders: readonly LinkedFolder[],
  flags: SetupFlags = FLAGS_ALL,
): SetupInput {
  return input({ linkedFolders: () => folders }, flags);
}

describe("runSetup linked folders", () => {
  test("should add a profile entry when the answer is this profile", async () => {
    // Arrange
    const setup = linkedInput([LINKED_SCRIPTS]);

    // Act
    const { outcome, output } = await run(setup, ["1", ""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.entries).toEqual([scriptsEntry("~/scripts")]);
    expect(outcome.record.entries).toBeUndefined();
    expect(output).toContain(`${LINKED_QUESTION} [1] `);
  });

  test("should add a machine entry when the answer is this machine", async () => {
    // Arrange
    const setup = linkedInput([LINKED_SCRIPTS]);

    // Act
    const { outcome } = await run(setup, ["2", ""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.entries).toBeUndefined();
    expect(outcome.record.entries).toEqual([scriptsEntry("~/scripts")]);
  });

  test("should store the no in the profile's destinations", async () => {
    // Arrange
    const setup = linkedInput([LINKED_SCRIPTS]);

    // Act
    const { outcome } = await run(setup, ["3", ""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.destinations).toEqual({
      "linked: ~/scripts": "no",
    });
    expect(outcome.profile.entries).toBeUndefined();
    expect(outcome.record.entries).toBeUndefined();
  });

  test("should take the suggestion under --yes without asking", async () => {
    // Arrange
    const outside: LinkedFolder = {
      ...LINKED_SCRIPTS,
      path: "/opt/tools",
      name: "tools",
      suggestion: "no",
    };
    const setup = linkedInput([LINKED_SCRIPTS, outside], {
      ...FLAGS_ALL,
      yes: true,
    });

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.entries).toEqual([scriptsEntry("~/scripts")]);
    expect(outcome.profile.destinations).toEqual({
      "linked: /opt/tools": "no",
    });
    expect(output).not.toContain("Sync it as a folder?");
  });

  test("should ask again after a bad answer", async () => {
    // Arrange
    const setup = linkedInput([LINKED_SCRIPTS]);

    // Act
    const { outcome, output } = await run(setup, ["4", "1", ""]);

    // Assert
    expect(output).toContain(
      `${LINKED_QUESTION} [1] Pick 1 to 3.\n${LINKED_QUESTION} [1] `,
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.entries).toEqual([scriptsEntry("~/scripts")]);
  });

  test("should number a second folder of the same name in the same layer", async () => {
    // Arrange
    const other: LinkedFolder = {
      ...LINKED_SCRIPTS,
      path: "~/work/scripts",
    };
    const setup = linkedInput([LINKED_SCRIPTS, other]);

    // Act
    const { outcome } = await run(setup, ["1", "1", ""]);

    // Assert
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.profile.entries).toEqual([
      scriptsEntry("~/scripts"),
      scriptsEntry("~/work/scripts", "linked/scripts-2"),
    ]);
  });

  test("should ask nothing when there are no linked folders", async () => {
    // Act
    const { output } = await run(input({}, FLAGS_ALL));

    // Assert
    expect(output).not.toContain("Sync it as a folder?");
  });
});

describe("guessProfile", () => {
  const PUBLIC = "public";
  const PRIVATE = "private";
  const DOMAIN = "corp.example";

  test("should guess personal on Linux without a domain", () => {
    expect(guessProfile(scan(), [], PUBLIC)).toEqual({
      name: "personal",
      reason: "personal (Linux, no domain).",
      takenByYes: false,
    });
  });

  test("should guess work1 on Linux with a domain", () => {
    const guess = guessProfile(scan({ domain: DOMAIN }), [], PRIVATE);
    expect(guess.name).toBe("work1");
    expect(guess.reason).toBe("new profile work1 (Linux, joined to a domain).");
    expect(guess.reason).not.toContain(DOMAIN);
  });

  test("should guess work1 on Windows and on macOS without a domain", () => {
    expect(guessProfile(scan({ os: "windows" }), [], PRIVATE).reason).toBe(
      "new profile work1 (Windows).",
    );
    expect(guessProfile(scan({ os: "macos" }), [], PRIVATE).reason).toBe(
      "new profile work1 (macOS).",
    );
  });

  test("should number past work1, work-3 and a retired work4", () => {
    const known = ["personal", "work1", "work-3", "work4"];
    expect(guessProfile(scan({ os: "windows" }), known, PRIVATE).name).toBe(
      "work5",
    );
  });

  test("should not count workbench or work-x", () => {
    const known = ["workbench", "work-x", "work"];
    expect(guessProfile(scan({ os: "windows" }), known, PRIVATE).name).toBe(
      "work1",
    );
  });

  test("should add the public note only while public", () => {
    const winScan = scan({ os: "windows" });
    expect(guessProfile(winScan, [], PUBLIC).reason).toBe(
      "new profile work1 (Windows); other machines' profiles can't be seen while the repo is public, so check the number",
    );
    expect(guessProfile(winScan, [], PRIVATE).reason).not.toContain("public");
    expect(guessProfile(scan(), [], PUBLIC).reason).not.toContain("public");
  });

  test("should let --yes take only a private work guess", () => {
    const winScan = scan({ os: "windows" });
    expect(guessProfile(winScan, [], PRIVATE).takenByYes).toBe(true);
    expect(guessProfile(winScan, [], PUBLIC).takenByYes).toBe(false);
    expect(guessProfile(scan(), [], PRIVATE).takenByYes).toBe(false);
  });
});

describe("runSetup profile guess and the hostname match", () => {
  test("should print no guess when the hostname match decides", async () => {
    const setup = input({
      profiles: [profile("work-1")],
      records: [record()],
      isPrivate: true,
    });
    const { output } = await run(setup, ["", "", ""]);
    expect(output).not.toContain("Guess:");
  });
});

describe("runSetup public name", () => {
  const ALL_FLAGS: SetupFlags = {
    name: "wk1-laptop",
    profile: "work-1",
    claude: "claude",
    mode: "push",
    existing: "stop",
    yes: true,
  };

  test("should guess <profile>-<os> and save it", async () => {
    const { outcome, output } = await run(input({}, ALL_FLAGS));
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.alias).toBe("work-1-linux");
    expect(output).toContain(
      "push with a preview.\nPublic name: work-1-linux\nSame as: ",
    );
    expect(output).toContain("--existing stop --alias work-1-linux\n");
  });

  test("should take --alias over the guess", async () => {
    const { outcome, output } = await run(
      input({}, { ...ALL_FLAGS, alias: "desk-a" }),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.alias).toBe("desk-a");
    expect(output).toContain("Public name: desk-a\n");
    expect(output).toContain("--existing stop --alias desk-a\n");
  });

  test("should refuse a bad --alias with exit 2 before any question", async () => {
    const { outcome, output } = await run(
      input({}, { ...ALL_FLAGS, yes: false, alias: "WK1-Laptop" }),
    );
    expect(outcome).toEqual({
      ok: false,
      message:
        "ERROR: 'WK1-Laptop' is this machine's hostname; pick another public name.",
      code: 2,
    });
    expect(output).toBe("");
  });

  test("should refuse an --alias that isn't alias form", async () => {
    const { outcome, output } = await run(
      input({}, { ...ALL_FLAGS, alias: "Desk A" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok || "declined" in outcome) throw new Error("expected error");
    expect(outcome.code).toBe(2);
    expect(outcome.message).toContain("invalid machine alias 'Desk A'");
    expect(output).toBe("");
  });

  test("should keep a replaced record's alias", async () => {
    const { outcome, output } = await run(
      input(
        {
          profiles: [profile("work-1")],
          records: [record({ alias: "old-desk" })],
        },
        {
          replace: "wk1-laptop",
          claude: "claude",
          mode: "push",
          existing: "stop",
          yes: true,
        },
      ),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.alias).toBe("old-desk");
    expect(output).toContain("Public name: old-desk\n");
    expect(output).toContain("--existing stop --alias old-desk\n");
  });

  test("should let --alias replace a kept alias", async () => {
    const { outcome } = await run(
      input(
        {
          profiles: [profile("work-1")],
          records: [record({ alias: "old-desk" })],
        },
        {
          replace: "wk1-laptop",
          claude: "claude",
          mode: "push",
          existing: "stop",
          alias: "new-desk",
          yes: true,
        },
      ),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.alias).toBe("new-desk");
  });

  test("should give a pull-only machine no public name", async () => {
    const { outcome, output } = await run(
      input({}, { ...ALL_FLAGS, mode: "pull-only" }),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.alias).toBeUndefined();
    expect(output).not.toContain("Public name:");
    expect(output).not.toContain("--alias");
  });

  test("should leave the alias out when the guess is refused", async () => {
    const { outcome, output } = await run(
      input(
        { scan: scan({ hostname: "work-1-linux" }) },
        { ...ALL_FLAGS, name: "box1" },
      ),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.alias).toBeUndefined();
    expect(output).not.toContain("Public name:");
  });
});

describe("runSetup label", () => {
  const QUESTIONS_AFTER_LABEL = [Q2, Q3].join("");

  test("should ask a label for a new work profile and keep it", async () => {
    // Arrange
    const setup = input({}, { existing: "stop" });

    // Act
    const { outcome, output } = await run(setup, [
      "work-1",
      "Big Co",
      "",
      "",
      "y",
    ]);

    // Assert
    expect(output).toContain(
      `${LABEL_QUESTION("work-1")}${QUESTIONS_AFTER_LABEL}`,
    );
    expect(output).toContain("profile work-1 (Big Co), Claude only");
    expect(output).toContain("--profile work-1 --label 'Big Co' --name");
    expect(outcome.ok && outcome.profile.label).toBe("Big Co");
  });

  test("should leave no label for an empty answer", async () => {
    // Act
    const { outcome, output } = await run(input({}, { existing: "stop" }), [
      "work-1",
      "",
      "",
      "",
      "y",
    ]);

    // Assert
    expect(output).toContain("profile work-1, Claude only");
    expect(output).not.toContain("--label");
    expect(outcome.ok && Object.hasOwn(outcome.profile, "label")).toBe(false);
  });

  test("should leave no label at end of input", async () => {
    // Act
    const { output } = await run(input({}, { existing: "stop" }), ["work-1"]);

    // Assert
    expect(output).toContain("profile work-1, Claude only");
    expect(output).not.toContain("--label");
  });

  test("should ask again for a bad typed label", async () => {
    // Act
    const { outcome, output } = await run(input({}, { existing: "stop" }), [
      "work-1",
      "a/b",
      "acme",
      "",
      "",
      "y",
    ]);

    // Assert
    expect(output).toContain("Use 1 to 30 letters, digits, spaces or .-_&.\n");
    expect(outcome.ok && outcome.profile.label).toBe("acme");
  });

  test("should not ask for personal", async () => {
    // Act
    const { output } = await run(input({}, { existing: "stop" }), ["personal"]);

    // Assert
    expect(output).not.toContain("Label for");
  });

  test("should not ask for an existing profile", async () => {
    // Act
    const { output } = await run(
      input({ profiles: [profile("work-1")] }, { existing: "stop" }),
      ["work-1"],
    );

    // Assert
    expect(output).not.toContain("Label for");
  });

  test("should not ask under --yes or --label", async () => {
    // Act
    const yes = await run(
      input({}, { profile: "work-1", yes: true, existing: "stop" }),
    );
    const flagged = await run(input({}, { existing: "stop", label: "acme" }), [
      "work-1",
    ]);

    // Assert
    expect(yes.output).not.toContain("Label for");
    expect(flagged.output).not.toContain("Label for");
    expect(flagged.output).toContain("profile work-1 (acme)");
    expect(flagged.output).toContain("--profile work-1 --label acme --name");
  });

  test("should not ask when --profile names the new profile", async () => {
    // Act
    const { output } = await run(
      input({}, { profile: "work-1", existing: "stop" }),
    );

    // Assert
    expect(output).not.toContain("Label for");
  });

  test("should stop with exit 2 before any question for --label on an existing profile", async () => {
    // Arrange
    const setup = input(
      { profiles: [profile("work-1")] },
      { profile: "work-1", label: "acme" },
    );

    // Act
    const { outcome, output } = await run(setup);

    // Assert
    expect(output).toBe("");
    expect(outcome).toMatchObject({
      ok: false,
      message: "ERROR: --label names a new profile; work-1 already exists",
      code: 2,
    });
  });

  test("should list, summarise and repeat a stored label", async () => {
    // Arrange
    const labelled = { ...profile("work-1"), label: "acme" };
    const setup = input(
      { profiles: [labelled, profile("work-2")] },
      { profile: "work-1", existing: "stop" },
    );

    // Act
    const { output } = await run(setup);

    // Assert
    expect(output).toContain("  2) work-1  (acme)\n  3) work-2\n");
    expect(output).toContain("profile work-1 (acme), Claude only");
    expect(output).not.toContain("--label");
  });
});
