import { describe, expect, test } from "bun:test";
import { doctorLines, installHint } from "./doctor.ts";
import type { DoctorFacts } from "./doctor.ts";

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
      "  WARN     2 value(s) not saved yet; mksync push or pull reads them from this machine's files",
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
