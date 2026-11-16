/**
 * Package drift (contract "Package drift"): the `DRIFT` and `SKIPPED` lines an
 * export or a preview prints after the orphan report on Linux. A pure
 * comparison: the adapter reads the lists, the package tools and the file
 * contents; this module parses the list texts and builds the lines.
 */
import { formatLine } from "./status.ts";

/** A tool-backed manager keeps two sets of names: what is installed at all
 * (present) and what the user asked for (chosen). */
export interface ManagerInstalled {
  readonly present: readonly string[];
  readonly chosen: readonly string[];
}

/** A manager whose tool did not answer; its note is `<tool> not installed` or
 * `<tool> failed`. */
export interface SkippedTool {
  readonly skipped: string;
}

/** What one manager reported, or why it could not report. */
export type ManagerResult = ManagerInstalled | SkippedTool;

/** apt keeps `present` even when `apt-mark` cannot answer: the missing lines
 * still print, and `chosen` carries the skip for the extras check. */
export interface AptInstalled {
  readonly present: readonly string[];
  readonly chosen: readonly string[] | SkippedTool;
}

/** What apt reported: a present set, or a skip from `dpkg-query`. */
export type AptResult = AptInstalled | SkippedTool;

/** A file of `apt-sources/` or `apt-sources/keyrings/`. `content` is absent
 * when the file exists but cannot be read, which the contract counts as not
 * installed. */
export interface PackageFile {
  readonly name: string;
  readonly content?: Uint8Array;
}

/** The two content managers' system side: the files they hold. */
export interface InstalledFiles {
  readonly files: readonly PackageFile[];
}

/** The system side of every manager, keyed as the contract's table names it. */
export interface Installed {
  readonly apt: AptResult;
  readonly snap: ManagerResult;
  readonly npm: ManagerResult;
  readonly pipx: ManagerResult;
  readonly vscode: ManagerResult;
  readonly font: ManagerResult;
  readonly extension: ManagerResult;
  readonly "apt-source": InstalledFiles;
  readonly "apt-key": InstalledFiles;
}

/** The parsed `packages/linux/` folder. */
export interface PackageLists {
  readonly apt: readonly string[];
  readonly deb: readonly string[];
  readonly snap: readonly string[];
  readonly npm: readonly string[];
  readonly pipx: readonly string[];
  readonly vscode: readonly string[];
  readonly font: readonly string[];
  readonly extension: readonly string[];
  /** Files directly in `apt-sources/` named `*.sources` or `*.list`. */
  readonly sources: readonly PackageFile[];
  /** Files directly in `apt-sources/keyrings/` named `*.gpg`. */
  readonly keys: readonly PackageFile[];
}

/** The text of each list file; a missing or unreadable file is left out. */
export interface PackageListTexts {
  readonly apt?: string;
  readonly deb?: string;
  readonly snap?: string;
  readonly npm?: string;
  readonly pipx?: string;
  readonly vscode?: string;
  readonly font?: string;
  readonly extension?: string;
  readonly sources?: readonly PackageFile[];
  readonly keys?: readonly PackageFile[];
}

const SOURCE_EXTENSIONS = [".sources", ".list"] as const;

const KEY_EXTENSION = ".gpg";

const encoder = new TextEncoder();

/** The name-list managers and the fields that hold their lists and results. */
type NameManagerList = "snap" | "npm" | "pipx" | "vscode" | "font" | "extension";

/** Report order for the name lists, as `report_drift` calls them. */
const NAME_MANAGERS: readonly {
  readonly manager: string;
  readonly file: string;
  readonly field: NameManagerList;
  readonly installed: NameManagerList;
}[] = [
  { manager: "snap", file: "snap.txt", field: "snap", installed: "snap" },
  { manager: "npm", file: "npm.txt", field: "npm", installed: "npm" },
  { manager: "pipx", file: "pipx.txt", field: "pipx", installed: "pipx" },
  {
    manager: "vscode",
    file: "vscode-extensions.txt",
    field: "vscode",
    installed: "vscode",
  },
  { manager: "font", file: "fonts.txt", field: "font", installed: "font" },
  {
    manager: "extension",
    file: "gnome-extensions.txt",
    field: "extension",
    installed: "extension",
  },
];

/** `LC_ALL=C sort` order: UTF-8 bytes, not UTF-16 code units. */
function compareC(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let i = 0; i < shared; i++) {
    const leftByte = leftBytes[i] ?? 0;
    const rightByte = rightBytes[i] ?? 0;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}

/** `sort -u`: empty names dropped, C-sorted, one copy each. */
function uniqueSorted(names: readonly string[]): string[] {
  const sorted = names.filter((name) => name !== "").sort(compareC);
  return sorted.filter((name, index) => index === 0 || name !== sorted[index - 1]);
}

/** One list file as `package_names` reads it: the first field of each line
 * that is not blank and not a comment, sorted and unique. */
function parseNames(text: string | undefined): string[] {
  if (text === undefined) {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const first = trimmed.split(/\s+/)[0];
    if (first !== undefined) {
      names.push(first);
    }
  }
  return uniqueSorted(names);
}

/** The files a `drift_source_names`-style read lists, sorted by name. */
function filesWithExtensions(
  files: readonly PackageFile[],
  extensions: readonly string[],
): PackageFile[] {
  const kept = files.filter((file) =>
    extensions.some((extension) => file.name.endsWith(extension)),
  );
  return [...kept].sort((left, right) => compareC(left.name, right.name));
}

/**
 * Parse the `packages/linux/` list files into the shape `driftLines` reads.
 * The `.txt` files go through the bash parser's rule; the `apt-sources/` and
 * `keyrings/` entries keep only the names the bash glob reaches.
 */
export function parsePackageLists(texts: PackageListTexts): PackageLists {
  return {
    apt: parseNames(texts.apt),
    deb: parseNames(texts.deb),
    snap: parseNames(texts.snap),
    npm: parseNames(texts.npm),
    pipx: parseNames(texts.pipx),
    vscode: parseNames(texts.vscode),
    font: parseNames(texts.font),
    extension: parseNames(texts.extension),
    sources: filesWithExtensions(texts.sources ?? [], SOURCE_EXTENSIONS),
    keys: filesWithExtensions(
      texts.keys ?? [],
      [KEY_EXTENSION],
    ),
  };
}

/** `drift-ignore.txt`: `<manager> <name>` lines, grouped by manager. */
function ignoredNames(ignore: readonly string[]): Map<string, Set<string>> {
  const ignored = new Map<string, Set<string>>();
  for (const line of ignore) {
    const fields = line.trim().split(/\s+/);
    const manager = fields[0];
    const name = fields[1];
    if (manager === undefined || manager === "" || name === undefined || name === "") {
      continue;
    }
    const names = ignored.get(manager) ?? new Set<string>();
    names.add(name);
    ignored.set(manager, names);
  }
  return ignored;
}

function emptyNames(): ReadonlySet<string> {
  return new Set<string>();
}

/** `drift_missing`: listed names the machine does not have. */
function missingLines(
  manager: string,
  file: string,
  listed: readonly string[],
  present: ReadonlySet<string>,
): string[] {
  return uniqueSorted(listed)
    .filter((name) => !present.has(name))
    .map((name) =>
      formatLine(
        "DRIFT",
        `${manager}/${name}`,
        `in packages/linux/${file}, not installed`,
      ),
    );
}

/** `drift_extra`: chosen names that are neither listed nor ignored. */
function extraLines(
  manager: string,
  file: string,
  listed: readonly string[],
  chosen: readonly string[],
  ignored: ReadonlySet<string>,
): string[] {
  const allowed = new Set<string>(uniqueSorted(listed));
  for (const name of ignored) {
    allowed.add(name);
  }
  return uniqueSorted(chosen)
    .filter((name) => !allowed.has(name))
    .map((name) =>
      formatLine(
        "DRIFT",
        `${manager}/${name}`,
        `installed, not in packages/linux/${file}`,
      ),
    );
}

/** The missing-then-extra block of one list-backed manager. */
function namesBlock(
  manager: string,
  file: string,
  listed: readonly string[],
  result: ManagerResult,
  ignored: ReadonlySet<string>,
): string[] {
  if ("skipped" in result) {
    return [formatLine("SKIPPED", `packages/linux/${file}`, result.skipped)];
  }
  const present = new Set(uniqueSorted(result.present));
  return [
    ...missingLines(manager, file, listed, present),
    ...extraLines(manager, file, listed, result.chosen, ignored),
  ];
}

/** `apt-mark` names lose their `:arch` suffix. */
function withoutArch(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(0, colon);
}

/** `drift_apt`: two lists for presence, their union for the chosen check. */
function aptBlock(
  lists: PackageLists,
  result: AptResult,
  ignored: ReadonlySet<string>,
): string[] {
  if ("skipped" in result) {
    return [formatLine("SKIPPED", "packages/linux/apt.txt", result.skipped)];
  }
  const present = new Set(uniqueSorted(result.present));
  const lines = [
    ...missingLines("apt", "apt.txt", lists.apt, present),
    ...missingLines("apt", "deb.txt", lists.deb, present),
  ];
  if ("skipped" in result.chosen) {
    lines.push(
      formatLine("SKIPPED", "packages/linux/apt.txt", result.chosen.skipped),
    );
    return lines;
  }
  lines.push(
    ...extraLines(
      "apt",
      "apt.txt",
      [...lists.apt, ...lists.deb],
      result.chosen.map(withoutArch),
      ignored,
    ),
  );
  return lines;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

/** `drift_apt_source`: names first, then the content of each listed source. */
function sourceBlock(
  lists: PackageLists,
  system: InstalledFiles,
  ignored: ReadonlySet<string>,
): string[] {
  const repoByName = new Map(lists.sources.map((file) => [file.name, file]));
  const systemByName = new Map(system.files.map((file) => [file.name, file]));
  const listed = uniqueSorted(lists.sources.map((file) => file.name));
  const present = uniqueSorted(system.files.map((file) => file.name));
  const lines = [
    ...missingLines("apt-source", "apt-sources", listed, new Set(present)),
    ...extraLines("apt-source", "apt-sources", listed, present, ignored),
  ];
  for (const name of listed) {
    const systemFile = systemByName.get(name);
    if (systemFile === undefined) {
      continue;
    }
    const repoFile = repoByName.get(name);
    if (repoFile?.content === undefined || systemFile.content === undefined) {
      lines.push(
        formatLine(
          "DRIFT",
          `apt-source/${name}`,
          "in packages/linux/apt-sources, not installed",
        ),
      );
    } else if (!sameBytes(repoFile.content, systemFile.content)) {
      lines.push(
        formatLine(
          "DRIFT",
          `apt-source/${name}`,
          "differs from packages/linux/apt-sources",
        ),
      );
    }
  }
  return lines;
}

/** `drift_apt_key`: only listed keys are checked, and never as extras. */
function keyBlock(lists: PackageLists, system: InstalledFiles): string[] {
  const repoByName = new Map(lists.keys.map((file) => [file.name, file]));
  const systemByName = new Map(system.files.map((file) => [file.name, file]));
  const lines: string[] = [];
  for (const name of uniqueSorted(lists.keys.map((file) => file.name))) {
    const repoFile = repoByName.get(name);
    const systemFile = systemByName.get(name);
    if (repoFile === undefined) {
      continue;
    }
    if (
      systemFile === undefined ||
      repoFile.content === undefined ||
      systemFile.content === undefined
    ) {
      lines.push(
        formatLine(
          "DRIFT",
          `apt-key/${name}`,
          "in packages/linux/apt-sources, not installed",
        ),
      );
    } else if (!sameBytes(repoFile.content, systemFile.content)) {
      lines.push(
        formatLine(
          "DRIFT",
          `apt-key/${name}`,
          "differs from packages/linux/apt-sources",
        ),
      );
    }
  }
  return lines;
}

/**
 * The drift report's lines, in the contract's order: apt, snap, npm, pipx,
 * vscode, font, extension, apt-source, apt-key. `ignore` holds the lines of
 * `drift-ignore.txt`; each `<manager> <name>` keeps that name out of the
 * "chosen" check for that manager only. The caller prints the lines and does
 * not count them.
 */
export function driftLines(
  lists: PackageLists,
  installed: Installed,
  ignore: readonly string[],
): readonly string[] {
  const ignored = ignoredNames(ignore);
  const ignoredFor = (manager: string): ReadonlySet<string> =>
    ignored.get(manager) ?? emptyNames();
  const lines = [
    ...aptBlock(lists, installed.apt, ignoredFor("apt")),
  ];
  for (const { manager, file, field, installed: key } of NAME_MANAGERS) {
    lines.push(
      ...namesBlock(
        manager,
        file,
        lists[field],
        installed[key],
        ignoredFor(manager),
      ),
    );
  }
  lines.push(
    ...sourceBlock(lists, installed["apt-source"], ignoredFor("apt-source")),
    ...keyBlock(lists, installed["apt-key"]),
  );
  return lines;
}
