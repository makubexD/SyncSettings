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

/** Git's own view of its config (contract "Front door", doctor). */
export interface GitFacts {
  /** `~/.config/git/config` exists. */
  readonly xdgConfig: boolean;
  /** Every `include.path` and `includeIf.*.path` value, home written as `~`. */
  readonly includes: readonly string[];
  /** This OS has a repo copy of `~/.gitconfig.local` and the file is missing. */
  readonly localMissing: boolean;
  /** The `gh` found on `PATH`. */
  readonly ghPath?: string;
  /** The `<GH_CLI_PATH>` value pull would write. */
  readonly ghCliValue?: string;
}

/**
 * What the app learned about the account git signs in as, when `gh` holds a
 * token for the origin's owner. The tokens are compared in memory only and
 * never reach a line.
 */
export interface GitLoginFact {
  /** `gh auth token --hostname github.com --user <owner>`: the owner's token. */
  readonly ownerToken: string;
  /** The first effective `credential.https://github.com.helper` names the owner. */
  readonly helperNamesOwner: boolean;
  /** The first effective helper is `gh auth git-credential`. */
  readonly helperIsGhCredential?: boolean;
  /** `gh auth token --hostname github.com`: the active token; asked only for the gh-git-credential helper. */
  readonly activeToken?: string;
}

/**
 * The helpers git will ask, in git's order: the entries after the last empty
 * value (an empty `helper =` resets the list). `values` are every
 * `credential.https://github.com.helper` entry across all scopes, in the order
 * `git config --get-all` prints them.
 */
export function effectiveHelpers(values: readonly string[]): string[] {
  const reset = values.lastIndexOf("");
  return values.slice(reset + 1);
}

/**
 * Whether the first effective helper runs `gh auth token --hostname github.com
 * --user <owner>`, with the owner as a whole name: the next character is not a
 * name character (so `owner1` does not match `owner10`). Case-insensitive, as
 * GitHub names are.
 */
export function helperNamesOwner(
  values: readonly string[],
  owner: string,
): boolean {
  const first = effectiveHelpers(values)[0];
  if (first === undefined) {
    return false;
  }
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `gh auth token --hostname github\\.com --user ${escaped}(?![A-Za-z0-9-])`,
    "i",
  );
  return pattern.test(first);
}

/** Whether the first effective helper is gh's own `gh auth git-credential`. */
export function helperIsGhCredential(values: readonly string[]): boolean {
  const first = effectiveHelpers(values)[0];
  return first !== undefined && first.includes("gh auth git-credential");
}

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
  /** Git's own view; undefined = not read, so no git config line. */
  readonly gitFacts?: GitFacts;
  /** The git login facts; undefined = no gh, no owner or no owner token, so no line. */
  readonly gitLogin?: GitLoginFact;
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

/**
 * Contract "Front door", git login: OK when the first effective helper names the owner or
 * is gh's git-credential and the active gh account is the owner's; otherwise WARN. No facts, no line.
 */
function gitLoginLines(login: GitLoginFact | undefined): string[] {
  if (login === undefined) {
    return [];
  }
  if (
    login.helperNamesOwner ||
    (login.helperIsGhCredential === true &&
      login.activeToken !== undefined &&
      login.activeToken === login.ownerToken)
  ) {
    return [checkLine("OK", "git login")];
  }
  return [
    checkLine(
      "WARN",
      "git login: git signs in as another GitHub account; run the install line again",
    ),
  ];
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
  return checkLine(
    "WARN",
    `bash: needed by the leak scan; install with ${hint}`,
  );
}

/** Contract "Front door": the unset-values line. Without a record setup's
 * import asks for them; with one, push and pull read them from this machine's
 * files (contract "Sanitize and hydrate", "Inference"). */
function valuesLine(unsetValues: number, record: boolean): string {
  if (unsetValues === 0) {
    return checkLine("OK", "values");
  }
  return checkLine(
    "WARN",
    record
      ? `${unsetValues} value(s) not saved yet; mksync push or pull fills them from this machine's files or asks for them`
      : `${unsetValues} value(s) not set; mksync setup asks for them`,
  );
}

/** The includes mksync syncs itself, so the doctor never warns about them. */
const SYNCED_INCLUDES: ReadonlySet<string> = new Set([
  "~/.gitconfig.local",
  "~/.gitconfig.machine",
]);

/** Windows paths compare without case and with either separator. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string): string =>
    path.replaceAll("\\", "/").toLowerCase();
  return norm(a) === norm(b);
}

/** Contract "Front door": the `gh` path line, Windows only, compared as `samePath` does. */
function ghPathLine(os: Os, g: GitFacts): string[] {
  const { ghPath, ghCliValue } = g;
  if (os !== "windows" || ghPath === undefined || ghCliValue === undefined) {
    return [];
  }
  if (samePath(ghPath, ghCliValue)) {
    return [];
  }
  return [
    checkLine(
      "WARN",
      `gh is ${ghPath}, not ${ghCliValue}; mksync pull would point git at the wrong gh`,
    ),
  ];
}

/** Contract "Front door": git's own view, up to four WARN lines in order. */
function gitConfigLines(os: Os, g: GitFacts | undefined): string[] {
  if (g === undefined) {
    return [];
  }
  const lines: string[] = [];
  if (g.xdgConfig) {
    lines.push(
      checkLine(
        "WARN",
        "git also reads ~/.config/git/config; mksync syncs ~/.gitconfig only",
      ),
    );
  }
  for (const path of g.includes) {
    if (!SYNCED_INCLUDES.has(path)) {
      lines.push(
        checkLine("WARN", `git includes ${path}, which mksync doesn't sync`),
      );
    }
  }
  if (g.localMissing) {
    lines.push(
      checkLine(
        "WARN",
        "~/.gitconfig.local is missing; mksync pull creates it from the repo",
      ),
    );
  }
  lines.push(...ghPathLine(os, g));
  return lines;
}

/** Contract "Front door": the doctor lines in order, then the verdict line. */
export function doctorLines(f: DoctorFacts): DoctorReport {
  const lines: string[] = [gitLine(f)];
  if (f.os === "macos") {
    lines.push(brewLine(f));
  }
  lines.push(
    ghLine(f),
    ...gitLoginLines(f.gitLogin),
    f.origin
      ? checkLine("OK", "repo clone with origin")
      : checkLine("WARN", "repo has no origin remote"),
    f.record
      ? checkLine("OK", "machine record")
      : checkLine("WARN", "no machine record; run mksync setup"),
    valuesLine(f.unsetValues, f.record),
    ...gitConfigLines(f.os, f.gitFacts),
    bashLine(f),
  );
  if (f.os === "linux" && f.drift !== undefined && f.drift > 0) {
    lines.push(
      checkLine(
        "WARN",
        `drift: ${f.drift} package(s) differ; run mksync preview`,
      ),
    );
  }
  if (!f.git || (f.os === "macos" && !hasBrew(f))) {
    lines.push(MISSING_NEXT);
    return { lines, code: 1 };
  }
  lines.push(READY);
  return { lines, code: 0 };
}
