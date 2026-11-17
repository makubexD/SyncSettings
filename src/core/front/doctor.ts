/**
 * Contract "Front door", `mksync doctor`: one `OK`, `WARN` or `MISSING` line per
 * check. Pure: the app gathers the facts through git, `gh` and the import
 * check, and prints the lines this module returns. Mirrors
 * `scripts/linux/front.sh` `front_doctor`.
 */

import type { Os } from "../config/types.ts";

/** The first package manager the app found, in its detection order. */
export type PackageManager = "brew" | "apt-get" | "dnf" | "pacman" | "winget";

/** What `gh auth status` said. */
export type GhFact = "missing" | "signed-out" | "signed-in";

/** Everything the doctor lines read. */
export interface DoctorFacts {
  readonly os: Os;
  /** The first package manager found, as the app detects it. */
  readonly packageManager: PackageManager | undefined;
  readonly git: boolean;
  readonly gh: GhFact;
  readonly origin: boolean;
  /** A machine record exists. */
  readonly record: boolean;
  readonly unsetValues: number;
  readonly bash: boolean;
  /** Packages that differ; undefined = no report (not linux, or no packages/linux). */
  readonly drift: number | undefined;
}

/** The doctor output lines, without line endings, and its exit code. */
export interface DoctorReport {
  readonly lines: readonly string[];
  readonly code: 0 | 1;
}

const WORD_WIDTH = 8;

const MISSING_NEXT = "  Fix the MISSING items, then run mksync doctor again.";

const READY = "  Ready.";

/** Contract "Front door", macOS: the only place Homebrew comes from. */
const BREW_MISSING = "brew: install from https://brew.sh";

type CheckWord = "OK" | "WARN" | "MISSING";

/** One check line, as bash `printf '  %-8s %s\n'` prints it. */
function checkLine(word: CheckWord, text: string): string {
  return `  ${word.padEnd(WORD_WIDTH)} ${text}`;
}

/** Contract "Front door": the install command for `pkg` on this OS. */
export function installHint(
  os: Os,
  pm: PackageManager | undefined,
  pkg: string,
): string {
  if (os === "macos") {
    return `brew install ${pkg}`;
  }
  switch (pm) {
    case "brew":
      return `brew install ${pkg}`;
    case "apt-get":
      return `sudo apt-get install ${pkg}`;
    case "dnf":
      return `sudo dnf install ${pkg}`;
    case "pacman":
      return `sudo pacman -S ${pkg}`;
    case "winget":
      return `winget install --id ${pkg}`;
    case undefined:
      return "your package manager";
  }
}

/** Windows with `winget` gets winget's exact ids; every other OS its own hint. */
function hasWinget(f: DoctorFacts): boolean {
  return f.os === "windows" && f.packageManager === "winget";
}

/** Contract "Front door": the `git` line. */
function gitLine(f: DoctorFacts): string {
  if (f.git) {
    return checkLine("OK", "git");
  }
  if (f.os === "windows") {
    return checkLine(
      "MISSING",
      hasWinget(f)
        ? "git: install with winget install --id Git.Git -e"
        : "git: install it from https://git-scm.com",
    );
  }
  return checkLine(
    "MISSING",
    `git: install with ${installHint(f.os, f.packageManager, "git")}`,
  );
}

/** Contract "Front door", macOS: Homebrew itself, the install hint's tool. */
function hasBrew(f: DoctorFacts): boolean {
  return f.packageManager === "brew";
}

/** Contract "Front door", macOS: the `brew` line, MISSING without Homebrew. */
function brewLine(f: DoctorFacts): string {
  return hasBrew(f)
    ? checkLine("OK", "brew")
    : checkLine("MISSING", BREW_MISSING);
}

/** Contract "Front door": the `gh` line, signed in, signed out or missing. */
function ghLine(f: DoctorFacts): string {
  switch (f.gh) {
    case "signed-in":
      return checkLine("OK", "gh (signed in)");
    case "signed-out":
      return checkLine("WARN", "gh: not signed in; run gh auth login");
    case "missing":
      return checkLine(
        "WARN",
        hasWinget(f)
          ? "gh: needed for push; install with winget install --id GitHub.cli -e"
          : "gh: needed for push; see https://cli.github.com",
      );
  }
}

/** Contract "Front door": the `bash` line, a WARN since only the leak scan needs it. */
function bashLine(f: DoctorFacts): string {
  if (f.bash) {
    return checkLine("OK", "bash");
  }
  if (f.os === "windows") {
    return checkLine(
      "WARN",
      hasWinget(f)
        ? "bash: needed by the leak scan; install with winget install --id Git.Git -e"
        : "bash: needed by the leak scan; install Git for Windows from https://git-scm.com",
    );
  }
  const hint = installHint(f.os, f.packageManager, "bash");
  return checkLine("WARN", `bash: needed by the leak scan; install with ${hint}`);
}

/** Contract "Front door": the unset-values line. */
function valuesLine(unsetValues: number): string {
  if (unsetValues > 0) {
    return checkLine(
      "WARN",
      `${unsetValues} value(s) not set; mksync setup asks for them`,
    );
  }
  return checkLine("OK", "values");
}

/** Contract "Front door": the doctor lines in order, then the verdict line. */
export function doctorLines(f: DoctorFacts): DoctorReport {
  const lines: string[] = [gitLine(f)];
  if (f.os === "macos") {
    lines.push(brewLine(f));
  }
  lines.push(
    ghLine(f),
    f.origin
      ? checkLine("OK", "repo clone with origin")
      : checkLine("WARN", "repo has no origin remote"),
    f.record
      ? checkLine("OK", "machine record")
      : checkLine("WARN", "no machine record; run mksync setup"),
    valuesLine(f.unsetValues),
    bashLine(f),
  );
  if (f.os === "linux" && f.drift !== undefined && f.drift > 0) {
    lines.push(
      checkLine("WARN", `drift: ${f.drift} package(s) differ; run mksync preview`),
    );
  }
  if (!f.git || (f.os === "macos" && !hasBrew(f))) {
    lines.push(MISSING_NEXT);
    return { lines, code: 1 };
  }
  lines.push(READY);
  return { lines, code: 0 };
}
