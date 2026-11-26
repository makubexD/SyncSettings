import { describe, expect, test } from "bun:test";
import { doctorLines, installHint } from "./doctor.ts";
import type { DoctorFacts, GitFacts } from "./doctor.ts";

const MISSING_NEXT = "  Fix the MISSING items, then run mksync doctor again.";

const READY = "  Ready.";

/** Every fact, with the values of a healthy Linux machine on apt-get. */
const ALL_OK_LINUX: DoctorFacts = {
  os: "linux",
  packageManager: "apt-get",
  git: true,
  gh: "signed-in",
  origin: true,
  record: true,
  unsetValues: 0,
  bash: true,
  drift: undefined,
};

function facts(changes: Partial<DoctorFacts>): DoctorFacts {
  return { ...ALL_OK_LINUX, ...changes };
}

/** The line at `index`, so a test reads only the text it checks. */
function line(f: DoctorFacts, index: number): string {
  const value = doctorLines(f).lines[index];
  if (value === undefined) {
    throw new Error(`no line ${index}`);
  }
  return value;
}

describe("doctorLines git line", () => {
  test("OK on a machine with git", () => {
    expect(line(facts({}), 0)).toBe("  OK       git");
  });

  test("MISSING on linux with apt-get names apt-get", () => {
    expect(line(facts({ git: false }), 0)).toBe(
      "  MISSING  git: install with sudo apt-get install git",
    );
  });

  test("MISSING on linux with no package manager", () => {
    expect(line(facts({ git: false, packageManager: undefined }), 0)).toBe(
      "  MISSING  git: install with your package manager",
    );
  });

  test("MISSING on linux with dnf names dnf", () => {
    expect(line(facts({ git: false, packageManager: "dnf" }), 0)).toBe(
      "  MISSING  git: install with sudo dnf install git",
    );
  });

  test("MISSING on linux with pacman names pacman", () => {
    expect(line(facts({ git: false, packageManager: "pacman" }), 0)).toBe(
      "  MISSING  git: install with sudo pacman -S git",
    );
  });

  test("MISSING on macos names brew", () => {
    expect(
      line(facts({ os: "macos", packageManager: "brew", git: false }), 0),
    ).toBe("  MISSING  git: install with brew install git");
  });

  test("MISSING on windows with winget names the exact id", () => {
    expect(
      line(
        facts({
          os: "windows",
          packageManager: "winget",
          git: false,
          bash: false,
        }),
        0,
      ),
    ).toBe("  MISSING  git: install with winget install --id Git.Git -e");
  });

  test("MISSING on windows without winget names git-scm.com", () => {
    expect(
      line(facts({ os: "windows", packageManager: undefined, git: false }), 0),
    ).toBe("  MISSING  git: install it from https://git-scm.com");
  });
});

describe("doctorLines brew line (front-macos-doctor-no-brew)", () => {
  test("MISSING with no brew on PATH, right after git, exit 1", () => {
    const report = doctorLines(
      facts({ os: "macos", packageManager: undefined }),
    );

    expect(report.lines[0]).toBe("  OK       git");
    expect(report.lines[1]).toBe(
      "  MISSING  brew: install from https://brew.sh",
    );
    expect(report.lines.at(-1)).toBe(MISSING_NEXT);
    expect(report.code).toBe(1);
  });

  test("OK with brew, right after git, Ready, exit 0", () => {
    const report = doctorLines(facts({ os: "macos", packageManager: "brew" }));

    expect(report.lines[0]).toBe("  OK       git");
    expect(report.lines[1]).toBe("  OK       brew");
    expect(report.lines.at(-1)).toBe(READY);
    expect(report.code).toBe(0);
  });

  test("linux has no brew line", () => {
    const report = doctorLines(facts({}));

    expect(report.lines.some((value) => value.includes("brew"))).toBe(false);
    expect(report.lines).toHaveLength(7);
  });

  test("windows has no brew line", () => {
    const report = doctorLines(
      facts({ os: "windows", packageManager: "winget" }),
    );

    expect(report.lines.some((value) => value.includes("brew"))).toBe(false);
    expect(report.lines).toHaveLength(7);
  });
});

describe("doctorLines gh line", () => {
  test("OK when signed in", () => {
    expect(line(facts({}), 1)).toBe("  OK       gh (signed in)");
  });

  test("WARN when signed out", () => {
    expect(line(facts({ gh: "signed-out" }), 1)).toBe(
      "  WARN     gh: not signed in; run gh auth login",
    );
  });

  test("WARN when missing on linux", () => {
    expect(line(facts({ gh: "missing" }), 1)).toBe(
      "  WARN     gh: needed for push; see https://cli.github.com",
    );
  });

  test("WARN when missing on windows with winget names the exact id", () => {
    expect(
      line(
        facts({ os: "windows", packageManager: "winget", gh: "missing" }),
        1,
      ),
    ).toBe(
      "  WARN     gh: needed for push; install with winget install --id GitHub.cli -e",
    );
  });

  test("WARN when missing on windows without winget names cli.github.com", () => {
    expect(
      line(
        facts({ os: "windows", packageManager: undefined, gh: "missing" }),
        1,
      ),
    ).toBe("  WARN     gh: needed for push; see https://cli.github.com");
  });
});

describe("doctorLines origin line", () => {
  test("OK with an origin remote", () => {
    expect(line(facts({}), 2)).toBe("  OK       repo clone with origin");
  });

  test("WARN without an origin remote", () => {
    expect(line(facts({ origin: false }), 2)).toBe(
      "  WARN     repo has no origin remote",
    );
  });
});

describe("doctorLines record line", () => {
  test("OK with a machine record", () => {
    expect(line(facts({}), 3)).toBe("  OK       machine record");
  });

  test("WARN without a machine record names setup", () => {
    expect(line(facts({ record: false }), 3)).toBe(
      "  WARN     no machine record; run mksync setup",
    );
  });
});

describe("doctorLines values line", () => {
  test("OK when every value is set", () => {
    expect(line(facts({}), 4)).toBe("  OK       values");
  });

  test("OK without a record when every value is set", () => {
    expect(line(facts({ record: false }), 4)).toBe("  OK       values");
  });

  test("WARN without a record names setup", () => {
    expect(line(facts({ unsetValues: 2, record: false }), 4)).toBe(
      "  WARN     2 value(s) not set; mksync setup asks for them",
    );
  });

  test("WARN with a record names push and pull", () => {
    expect(line(facts({ unsetValues: 2 }), 4)).toBe(
      "  WARN     2 value(s) not saved yet; mksync push or pull fills them from this machine's files or asks for them",
    );
  });
});

describe("doctorLines bash line", () => {
  test("OK on a machine with bash", () => {
    expect(line(facts({}), 5)).toBe("  OK       bash");
  });

  test("WARN on linux with apt-get names apt-get", () => {
    expect(line(facts({ bash: false }), 5)).toBe(
      "  WARN     bash: needed by the leak scan; install with sudo apt-get install bash",
    );
  });

  test("WARN on linux with no package manager", () => {
    expect(line(facts({ bash: false, packageManager: undefined }), 5)).toBe(
      "  WARN     bash: needed by the leak scan; install with your package manager",
    );
  });

  test("WARN on macos names brew", () => {
    expect(
      line(facts({ os: "macos", packageManager: "brew", bash: false }), 6),
    ).toBe(
      "  WARN     bash: needed by the leak scan; install with brew install bash",
    );
  });

  test("WARN on windows with winget names Git.Git", () => {
    expect(
      line(facts({ os: "windows", packageManager: "winget", bash: false }), 5),
    ).toBe(
      "  WARN     bash: needed by the leak scan; install with winget install --id Git.Git -e",
    );
  });

  test("WARN on windows without winget names Git for Windows", () => {
    expect(
      line(facts({ os: "windows", packageManager: undefined, bash: false }), 5),
    ).toBe(
      "  WARN     bash: needed by the leak scan; install Git for Windows from https://git-scm.com",
    );
  });
});

describe("doctorLines drift line", () => {
  test("linux with differing packages adds the warn before the verdict", () => {
    const report = doctorLines(facts({ drift: 2 }));

    expect(report.lines).toHaveLength(8);
    expect(report.lines[6]).toBe(
      "  WARN     drift: 2 package(s) differ; run mksync preview",
    );
    expect(report.lines[7]).toBe(READY);
  });

  test("linux with no drift has no line", () => {
    const report = doctorLines(facts({ drift: 0 }));

    expect(report.lines).toHaveLength(7);
    expect(report.lines[6]).toBe(READY);
  });

  test("linux with no report has no line", () => {
    expect(doctorLines(facts({ drift: undefined })).lines).toHaveLength(7);
  });

  test("windows with a report has no line", () => {
    const report = doctorLines(facts({ os: "windows", drift: 2 }));

    expect(report.lines).toHaveLength(7);
    expect(report.lines[6]).toBe(READY);
  });

  test("macos with a report has no line", () => {
    expect(
      doctorLines(facts({ os: "macos", packageManager: "brew", drift: 2 }))
        .lines,
    ).toHaveLength(8);
  });
});

describe("doctorLines exit code", () => {
  test("0 when nothing is MISSING", () => {
    expect(doctorLines(facts({ gh: "missing", bash: false })).code).toBe(0);
  });

  test("1 when git is missing, with the fix line last", () => {
    const report = doctorLines(facts({ git: false }));

    expect(report.code).toBe(1);
    expect(report.lines.at(-1)).toBe(MISSING_NEXT);
  });
});

describe("doctorLines", () => {
  test("prints every line of an all-OK linux machine, then Ready", () => {
    expect(doctorLines(facts({})).lines).toEqual([
      "  OK       git",
      "  OK       gh (signed in)",
      "  OK       repo clone with origin",
      "  OK       machine record",
      "  OK       values",
      "  OK       bash",
      "  Ready.",
    ]);
  });
});

/** Git's own view with nothing to report. */
const NO_GIT_FACTS: GitFacts = {
  xdgConfig: false,
  includes: [],
  localMissing: false,
};

const XDG_LINE =
  "  WARN     git also reads ~/.config/git/config; mksync syncs ~/.gitconfig only";

const WORK_INCLUDE = "~/work/.gitconfig";

const INCLUDE_LINE = `  WARN     git includes ${WORK_INCLUDE}, which mksync doesn't sync`;

const LOCAL_MISSING_LINE =
  "  WARN     ~/.gitconfig.local is missing; mksync pull creates it from the repo";

const FOUND_GH = "C:\\Users\\u\\AppData\\Local\\gh\\gh.exe";

const SAVED_GH = "C:\\Program Files\\GitHub CLI\\gh.exe";

const GH_PATH_LINE = `  WARN     gh is ${FOUND_GH}, not ${SAVED_GH}; mksync pull would point git at the wrong gh`;

/** The healthy Linux machine with these git facts. */
function withGit(
  changes: Partial<GitFacts>,
  os: DoctorFacts["os"] = "linux",
): DoctorFacts {
  return facts({ os, gitFacts: { ...NO_GIT_FACTS, ...changes } });
}

/** The lines between `values` and `bash`, where the git lines go. */
function gitLines(f: DoctorFacts): readonly string[] {
  const lines = doctorLines(f).lines;
  const values = lines.findIndex((value) => value.includes("values"));
  const bash = lines.findIndex((value) => value.includes("bash"));
  return lines.slice(values + 1, bash);
}

describe("doctorLines git config lines", () => {
  test("should warn about ~/.config/git/config when it exists", () => {
    expect(gitLines(withGit({ xdgConfig: true }))).toEqual([XDG_LINE]);
  });

  test("should warn once per include other than the synced two", () => {
    const includes = [
      "~/.gitconfig.local",
      "~/.gitconfig.machine",
      WORK_INCLUDE,
    ];

    expect(gitLines(withGit({ includes }))).toEqual([INCLUDE_LINE]);
  });

  test("should warn when ~/.gitconfig.local is missing", () => {
    expect(gitLines(withGit({ localMissing: true }))).toEqual([
      LOCAL_MISSING_LINE,
    ]);
  });

  test("should warn on windows when gh differs from GH_CLI_PATH", () => {
    const f = withGit({ ghPath: FOUND_GH, ghCliValue: SAVED_GH }, "windows");

    expect(gitLines(f)).toEqual([GH_PATH_LINE]);
  });

  test("should not warn on windows when the paths match without case", () => {
    const f = withGit(
      { ghPath: SAVED_GH.toLowerCase(), ghCliValue: SAVED_GH },
      "windows",
    );

    expect(gitLines(f)).toEqual([]);
  });

  test("should not warn on windows when the paths differ only in separators", () => {
    const f = withGit(
      { ghPath: SAVED_GH.replaceAll("\\", "/"), ghCliValue: SAVED_GH },
      "windows",
    );

    expect(gitLines(f)).toEqual([]);
  });

  test("should not warn on windows when only one path is known", () => {
    expect(gitLines(withGit({ ghPath: FOUND_GH }, "windows"))).toEqual([]);
  });

  test("should never print the gh path line on linux", () => {
    const f = withGit({ ghPath: FOUND_GH, ghCliValue: SAVED_GH });

    expect(gitLines(f)).toEqual([]);
  });

  test("should print the lines in the contract's order", () => {
    const f = withGit(
      {
        xdgConfig: true,
        includes: [WORK_INCLUDE],
        localMissing: true,
        ghPath: FOUND_GH,
        ghCliValue: SAVED_GH,
      },
      "windows",
    );

    expect(gitLines(f)).toEqual([
      XDG_LINE,
      INCLUDE_LINE,
      LOCAL_MISSING_LINE,
      GH_PATH_LINE,
    ]);
  });

  test("should print no git line without facts or with nothing to report", () => {
    expect(gitLines(facts({}))).toEqual([]);
    expect(gitLines(withGit({}))).toEqual([]);
  });

  test("should keep the exit code whatever the git lines say", () => {
    const all = withGit({
      xdgConfig: true,
      includes: [WORK_INCLUDE],
      localMissing: true,
    });

    expect(doctorLines(all).code).toBe(0);
    expect(doctorLines({ ...all, git: false }).code).toBe(1);
    expect(doctorLines(all).lines.at(-1)).toBe(READY);
  });
});

describe("installHint", () => {
  test("macos always names brew", () => {
    expect(installHint("macos", undefined, "git")).toBe("brew install git");
  });

  test("macos keeps brew over another package manager", () => {
    expect(installHint("macos", "apt-get", "jq")).toBe("brew install jq");
  });

  test("apt-get", () => {
    expect(installHint("linux", "apt-get", "git")).toBe(
      "sudo apt-get install git",
    );
  });

  test("dnf", () => {
    expect(installHint("linux", "dnf", "git")).toBe("sudo dnf install git");
  });

  test("pacman", () => {
    expect(installHint("linux", "pacman", "git")).toBe("sudo pacman -S git");
  });

  test("winget", () => {
    expect(installHint("windows", "winget", "Git.Git")).toBe(
      "winget install --id Git.Git",
    );
  });

  test("brew on a non-macos OS", () => {
    expect(installHint("linux", "brew", "jq")).toBe("brew install jq");
  });

  test("no package manager found", () => {
    expect(installHint("linux", undefined, "git")).toBe("your package manager");
  });
});
