import { describe, expect, test } from "bun:test";
import { formatTokens, parsePayload, progressBar, statusLine } from "./format.ts";
import type { GitFacts, StatusFacts, StatusPayload } from "./format.ts";

const RESET = "\u001b[0m";
const CYAN = "\u001b[96m";
const YELLOW = "\u001b[93m";
const MAGENTA = "\u001b[95m";
const BLUE = "\u001b[94m";
const GREEN = "\u001b[92m";
const YELLOW_DIM = "\u001b[33m";
const RED = "\u001b[91m";
const GRAY = "\u001b[90m";

const SEPARATOR = ` ${GRAY}|${RESET} `;
const TIME = "09:30";
const UNAVAILABLE = "Statusline data unavailable\n";

const EMPTY_PAYLOAD: StatusPayload = {
  model: "",
  projectDir: "",
  directory: "",
  cost: undefined,
  remainingPercentage: undefined,
  usedPercentage: undefined,
  totalInputTokens: undefined,
  contextWindowSize: undefined,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputStyle: "",
  sessionId: "",
};

const CLEAN_GIT: GitFacts = {
  branch: "master",
  dirty: false,
  insertions: 0,
  deletions: 0,
  untracked: 0,
};

const MEM_USED_MIB = 3174.4;
const MEM_TOTAL_MIB = 15872;

function makePayload(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return { ...EMPTY_PAYLOAD, ...overrides };
}

function makeFacts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return { time: TIME, ...overrides };
}

function makeGit(overrides: Partial<GitFacts> = {}): GitFacts {
  return { ...CLEAN_GIT, ...overrides };
}

function paint(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

function timeSection(): string {
  return paint(GRAY, TIME);
}

function line(...sections: string[]): string {
  return `${sections.join(SEPARATOR)}\n`;
}

describe("parsePayload", () => {
  const FULL_JSON = JSON.stringify({
    model: { display_name: "Claude Example" },
    workspace: { project_dir: "/home/user/proj", current_dir: "/home/user/current" },
    cwd: "/home/user/proj/sub",
    cost: { total_cost_usd: 0.12 },
    context_window: {
      remaining_percentage: 60,
      used_percentage: 40,
      total_input_tokens: 80000,
      context_window_size: 200000,
      current_usage: { cache_creation_input_tokens: 1000, cache_read_input_tokens: 500 },
    },
    output_style: { name: "explanatory" },
    session_id: "abc-1",
  });

  test("should read every field the contract names", () => {
    // Arrange

    // Act
    const payload = parsePayload(FULL_JSON);

    // Assert
    expect(payload).toEqual({
      model: "Claude Example",
      projectDir: "/home/user/proj",
      directory: "/home/user/proj/sub",
      cost: 0.12,
      remainingPercentage: 60,
      usedPercentage: 40,
      totalInputTokens: 80000,
      contextWindowSize: 200000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
      outputStyle: "explanatory",
      sessionId: "abc-1",
    });
  });

  const DIRECTORY_CASES: readonly (readonly [string, unknown, string])[] = [
    [
      "cwd",
      { cwd: "/a/cwd", workspace: { current_dir: "/a/current", project_dir: "/a/project" } },
      "/a/cwd",
    ],
    ["workspace.current_dir", { workspace: { current_dir: "/a/current", project_dir: "/a/project" } }, "/a/current"],
    ["workspace.project_dir", { workspace: { project_dir: "/a/project" } }, "/a/project"],
    ["nothing", {}, ""],
  ];

  test.each(DIRECTORY_CASES)("should take the directory from %s", (_label, raw, expected) => {
    // Arrange
    const text = JSON.stringify(raw);

    // Act
    const payload = parsePayload(text);

    // Assert
    expect(payload.directory).toBe(expected);
  });

  test("should give empty values for missing and null fields", () => {
    // Arrange
    const text = JSON.stringify({
      model: null,
      workspace: { project_dir: null },
      cwd: null,
      cost: null,
      context_window: null,
      output_style: null,
      session_id: null,
    });

    // Act
    const payload = parsePayload(text);

    // Assert
    expect(payload).toEqual(EMPTY_PAYLOAD);
  });

  test.each(["not json\n", "", "null", "[]", "42"])(
    "should give empty values for %p",
    (text) => {
      // Arrange

      // Act
      const payload = parsePayload(text);

      // Assert
      expect(payload).toEqual(EMPTY_PAYLOAD);
    },
  );
});

describe("formatTokens", () => {
  const TOKEN_CASES: readonly (readonly [number, string])[] = [
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [1500, "1.5k"],
    [80000, "80k"],
    [1000000, "1M"],
    [1500000, "1.5M"],
  ];

  test.each(TOKEN_CASES)("should format %d tokens as %s", (tokens, expected) => {
    // Arrange

    // Act
    const text = formatTokens(tokens);

    // Assert
    expect(text).toBe(expected);
  });
});

describe("progressBar", () => {
  const BAR_CASES: readonly (readonly [number, string])[] = [
    [0, "[░░░░░░░░░░]"],
    [50, "[█████░░░░░]"],
    [100, "[██████████]"],
    [63, "[██████░░░░]"],
    [110, "[██████████]"],
  ];

  test.each(BAR_CASES)("should draw %d percent as %s", (percent, expected) => {
    // Arrange

    // Act
    const bar = progressBar(percent);

    // Assert
    expect(bar).toBe(expected);
  });
});

describe("statusLine", () => {
  test("should print the unavailable line when no section has data", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ time: "" });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(UNAVAILABLE);
  });

  test("should print the time alone", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(`${timeSection()}\n`);
  });

  test("should print the model in cyan", () => {
    // Arrange
    const payload = makePayload({ model: "Claude Example" });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(CYAN, "Claude Example")));
  });

  test("should print .venv when the project has one and a pyproject.toml", () => {
    // Arrange
    const payload = makePayload({ projectDir: "/home/user/proj" });
    const facts = makeFacts({ projectFiles: ["pyproject.toml"], hasVenvDir: true });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(GREEN, ".venv"), paint(BLUE, "Python")),
    );
  });

  test("should print the last part of VIRTUAL_ENV when the project has no venv", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ virtualEnv: "/home/user/envs/work" });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(GREEN, "work")));
  });

  test("should print the conda environment when it is the only one", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ condaEnv: "base" });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(GREEN, "conda:base")));
  });

  const PROJECT_TYPE_CASES: readonly (readonly [readonly string[], string])[] = [
    [["pyproject.toml"], "Python"],
    [["package.json"], "Node.js"],
    [["Cargo.toml"], "Rust"],
    [["go.mod"], "Go"],
    [["app.csproj"], ".NET"],
    [["app.sln"], ".NET"],
    [["pyproject.toml", "package.json"], "Python"],
    [[], ""],
  ];

  test.each(PROJECT_TYPE_CASES)("should label project files %p as %p", (files, expected) => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ projectFiles: files });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    const sections = expected ? [timeSection(), paint(BLUE, expected)] : [timeSection()];
    expect(text).toBe(line(...sections));
  });

  const DIRECTORY_CASES: readonly (readonly [string, string])[] = [
    ["/home/user/proj", "proj"],
    ["/home/user/proj/", "proj"],
    ["/", ""],
    ["", ""],
  ];

  test.each(DIRECTORY_CASES)("should take %p as the directory %p", (directory, expected) => {
    // Arrange
    const payload = makePayload({ directory });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    const sections = expected ? [timeSection(), paint(YELLOW, expected)] : [timeSection()];
    expect(text).toBe(line(...sections));
  });

  test("should leave out both git sections when there is no repository", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(`${timeSection()}\n`);
  });

  test("should leave out both git sections when the branch is empty", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ branch: "" }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(`${timeSection()}\n`);
  });

  test("should mark a dirty branch with an asterisk", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ dirty: true }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(MAGENTA, "master*")));
  });

  test("should show ahead and behind counts against the upstream", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ ahead: 2, behind: 1 }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(MAGENTA, "master ↑2 ↓1")));
  });

  test("should show insertions, deletions and untracked files", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ insertions: 12, deletions: 3, untracked: 2 }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(MAGENTA, "master"), paint(YELLOW, "(+12,-3) 2?")),
    );
  });

  test("should show only the untracked count when nothing is modified", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ untracked: 2 }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(MAGENTA, "master"), paint(YELLOW, "2?")));
  });

  test("should keep a zero deletion in the change count", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ insertions: 1 }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(MAGENTA, "master"), paint(YELLOW, "(+1,-0)")),
    );
  });

  const AGE_CASES: readonly (readonly [string, string])[] = [
    ["30 seconds ago", "30s"],
    ["3 minutes ago", "3m"],
    ["2 hours ago", "2h"],
    ["1 day ago", "1d"],
    ["2 weeks ago", "2w"],
    ["3 months ago", "3mo"],
    ["4 years ago", "4y"],
  ];

  test.each(AGE_CASES)("should shorten %p to the git age %p", (age, shortened) => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ git: makeGit({ age }) });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(MAGENTA, `master ${shortened}`)));
  });

  const COST_CASES: readonly (readonly [number, string, string])[] = [
    [0.12, GREEN, "$0.12"],
    [0.125, GREEN, "$0.12"],
    [0.5, YELLOW_DIM, "$0.50"],
    [2, YELLOW_DIM, "$2.00"],
    [2.01, RED, "$2.01"],
  ];

  test.each(COST_CASES)("should color a cost of %d as %s", (cost, color, text) => {
    // Arrange
    const payload = makePayload({ cost });
    const facts = makeFacts();

    // Act
    const lineText = statusLine(payload, facts);

    // Assert
    expect(lineText).toBe(line(timeSection(), paint(color, `Cost: ${text}`)));
  });

  const CONTEXT_COLOR_CASES: readonly (readonly [number, string])[] = [
    [100, GREEN],
    [61, GREEN],
    [60, YELLOW_DIM],
    [30, YELLOW_DIM],
    [29, RED],
    [0, RED],
  ];

  test.each(CONTEXT_COLOR_CASES)(
    "should color %d percent left as %s",
    (remaining, color) => {
      // Arrange
      const payload = makePayload({ remainingPercentage: remaining });
      const facts = makeFacts();

      // Act
      const text = statusLine(payload, facts);

      // Assert
      expect(text).toBe(
        line(timeSection(), paint(color, `Context: ${progressBar(remaining)} ${remaining}%`)),
      );
    },
  );

  test("should take the percent from the used percentage when remaining is missing", () => {
    // Arrange
    const payload = makePayload({ usedPercentage: 40 });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(YELLOW_DIM, `Context: ${progressBar(60)} 60%`)),
    );
  });

  test("should round the percent as the script's printf does", () => {
    // Arrange
    const payload = makePayload({ remainingPercentage: 60.5 });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(YELLOW_DIM, `Context: ${progressBar(60)} 60%`)),
    );
  });

  test("should print the token counts when both are known", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 60,
      totalInputTokens: 80000,
      contextWindowSize: 200000,
    });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(
        timeSection(),
        paint(YELLOW_DIM, `Context: ${progressBar(60)} 80k/200k (60%)`),
      ),
    );
  });

  test("should print only the percent when the window size is 0", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 60,
      totalInputTokens: 80000,
      contextWindowSize: 0,
    });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(YELLOW_DIM, `Context: ${progressBar(60)} 60%`)),
    );
  });

  test("should add CLEAR when the tokens used reach the default limit", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 79,
      totalInputTokens: 210000,
      contextWindowSize: 1000000,
    });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(
        timeSection(),
        paint(
          GREEN,
          `Context: ${progressBar(79)} 210k/1M (79%) ${YELLOW_DIM}CLEAR${RESET}`,
        ),
      ),
    );
  });

  test("should not add CLEAR below the default limit", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 79,
      totalInputTokens: 199999,
      contextWindowSize: 1000000,
    });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(GREEN, `Context: ${progressBar(79)} 200k/1M (79%)`)),
    );
  });

  test("should lower the CLEAR limit to 70% of a smaller window", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 30,
      totalInputTokens: 70000,
      contextWindowSize: 100000,
    });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(
        timeSection(),
        paint(
          YELLOW_DIM,
          `Context: ${progressBar(30)} 70k/100k (30%) ${YELLOW_DIM}CLEAR${RESET}`,
        ),
      ),
    );
  });

  test("should take CONTEXT_CLEAR_AT when it is lower than the window limit", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 79,
      totalInputTokens: 210000,
      contextWindowSize: 1000000,
    });
    const facts = makeFacts({ clearAt: 300000 });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(GREEN, `Context: ${progressBar(79)} 210k/1M (79%)`)),
    );
  });

  test("should add CLEAR when CONTEXT_CLEAR_AT is reached earlier", () => {
    // Arrange
    const payload = makePayload({
      remainingPercentage: 79,
      totalInputTokens: 1000,
      contextWindowSize: 1000000,
    });
    const facts = makeFacts({ clearAt: 1000 });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(
        timeSection(),
        paint(
          GREEN,
          `Context: ${progressBar(79)} 1k/1M (79%) ${YELLOW_DIM}CLEAR${RESET}`,
        ),
      ),
    );
  });

  test("should print the cached tokens in cyan", () => {
    // Arrange
    const payload = makePayload({
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
    });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(CYAN, "Cached: 1.5k")));
  });

  test("should leave the cached section out when nothing is cached", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(`${timeSection()}\n`);
  });

  test("should print the load and the memory in cyan", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({
      load: "0.42",
      mem: { usedMiB: MEM_USED_MIB, totalMiB: MEM_TOTAL_MIB },
    });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(CYAN, "Load: 0.42"), paint(CYAN, "Mem: 3.1G/15.5G")),
    );
  });

  test("should round a half GiB to even as printf does", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ mem: { usedMiB: 1280, totalMiB: 2048 } });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(CYAN, "Mem: 1.2G/2.0G")));
  });

  test("should leave out the load and the memory when the system has no such data", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(`${timeSection()}\n`);
  });

  test("should print a non-default output style in blue", () => {
    // Arrange
    const payload = makePayload({ outputStyle: "explanatory" });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(BLUE, "explanatory")));
  });

  test("should leave out the default output style", () => {
    // Arrange
    const payload = makePayload({ outputStyle: "default" });
    const facts = makeFacts();

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(`${timeSection()}\n`);
  });

  test("should print WORKER in green when worker mode is on", () => {
    // Arrange
    const payload = makePayload();
    const facts = makeFacts({ workerMode: true });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(line(timeSection(), paint(GREEN, "WORKER")));
  });

  test("should print every section in the contract's order", () => {
    // Arrange
    const payload = makePayload({
      model: "Claude Example",
      projectDir: "/home/user/proj",
      directory: "/home/user/proj/",
      cost: 0.12,
      remainingPercentage: 60,
      totalInputTokens: 80000,
      contextWindowSize: 200000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
      outputStyle: "explanatory",
    });
    const facts = makeFacts({
      projectFiles: ["pyproject.toml"],
      hasVenvDir: true,
      git: makeGit({ dirty: true, ahead: 1, age: "3 hours ago", insertions: 4, deletions: 2, untracked: 1 }),
      load: "0.42",
      mem: { usedMiB: MEM_USED_MIB, totalMiB: MEM_TOTAL_MIB },
      workerMode: true,
    });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(
        timeSection(),
        paint(CYAN, "Claude Example"),
        paint(GREEN, ".venv"),
        paint(BLUE, "Python"),
        paint(YELLOW, "proj"),
        paint(MAGENTA, "master* ↑1 3h"),
        paint(YELLOW, "(+4,-2) 1?"),
        `${paint(GREEN, "Cost: $0.12")}${SEPARATOR}${paint(
          YELLOW_DIM,
          `Context: ${progressBar(60)} 80k/200k (60%)`,
        )}`,
        paint(CYAN, "Cached: 1.5k"),
        paint(CYAN, "Load: 0.42"),
        paint(CYAN, "Mem: 3.1G/15.5G"),
        paint(BLUE, "explanatory"),
        paint(GREEN, "WORKER"),
      ),
    );
  });

  test("should print only the facts sections for a payload that is not JSON", () => {
    // Arrange
    const payload = parsePayload("not json\n");
    const facts = makeFacts({
      load: "0.42",
      mem: { usedMiB: MEM_USED_MIB, totalMiB: MEM_TOTAL_MIB },
    });

    // Act
    const text = statusLine(payload, facts);

    // Assert
    expect(text).toBe(
      line(timeSection(), paint(CYAN, "Load: 0.42"), paint(CYAN, "Mem: 3.1G/15.5G")),
    );
  });
});
