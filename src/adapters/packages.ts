/**
 * The Linux package adapter (contract "Package drift"): reads what each
 * manager has installed, the `packages/linux/` list texts and
 * `drift-ignore.txt`, so `core/drift.ts` can compare them.
 *
 * Every tool call goes through an injectable `run` and every filesystem read
 * takes the home and root folders as parameters, so a test never reaches a
 * real manager or the real machine. The readers mirror the bash drift helpers
 * in `scripts/linux/sync.sh`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Installed,
  ManagerResult,
  PackageFile,
  PackageListTexts,
} from "../core/drift.ts";

/** One tool run: its stdout when it exited 0, or why it did not succeed. */
export type RunResult =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/** One tool call: the command, its arguments, and what it printed. */
export type Run = (cmd: string, args: readonly string[]) => RunResult;

/** Where the installed side is read: the user's home, the `DRIFT_ROOT`
 * prefix, and the tool runner (the real one by default). */
export interface InstalledInput {
  readonly home: string;
  readonly root: string;
  readonly run?: Run;
}

/** A command that is not on `PATH`; Bun reports it as this spawn error. */
const NOT_FOUND = "ENOENT";

/** `dpkg-query`'s format: the package's status, a space, then its name. */
const DPKG_FORMAT = '-f=${db:Status-Status} ${Package}\\n';

/** `apt-mark` names carry `:arch`; bash keeps only the part before the colon. */
const ARCH_SEPARATOR = ":";

/** `snap list` rows whose `Notes` name one of these are infrastructure. */
const SNAP_INFRASTRUCTURE = /(^|,)(base|snapd)(,|$)/;

/** The list files under `packages/linux/`, keyed as `PackageListTexts` names them. */
const LIST_TEXTS = [
  ["apt", "apt.txt"],
  ["deb", "deb.txt"],
  ["snap", "snap.txt"],
  ["npm", "npm.txt"],
  ["pipx", "pipx.txt"],
  ["vscode", "vscode-extensions.txt"],
  ["font", "fonts.txt"],
  ["extension", "gnome-extensions.txt"],
] as const;

type ListTextField = (typeof LIST_TEXTS)[number][0];

/** The repo files `drift_source_names <dir> lists` reaches. */
const SOURCE_EXTENSIONS = [".sources", ".list"] as const;

/** The repo file extension `drift_apt_key` reaches. */
const KEY_EXTENSION = ".gpg";

/** The font folder the contract's font manager reads. */
const FONT_FOLDER = [".local", "share", "fonts", "NerdFonts"] as const;

/** The extension folder the contract's extension manager reads. */
const EXTENSION_FOLDER = [".local", "share", "gnome-shell", "extensions"] as const;

/** The system folders apt sources and keys live in, under `<root>`. */
const SOURCES_FOLDER = ["etc", "apt", "sources.list.d"] as const;

const SHARED_KEYRINGS = ["usr", "share", "keyrings"] as const;

const LOCAL_KEYRINGS = ["etc", "apt", "keyrings"] as const;

/** The nvm folder whose version folders `sort -V` picks from. */
const NVM_VERSIONS = [".nvm", "versions", "node"] as const;

const encoder = new TextEncoder();

/** The `code` of a Bun spawn error, when it has one. */
function spawnErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code: unknown = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The real runner: `cmd` with an argument array and no shell, like the dconf
 * adapter. A missing command is `missing`, a non-zero exit or any other spawn
 * error is `failed`.
 */
export function runCommand(cmd: string, args: readonly string[]): RunResult {
  try {
    const result = Bun.spawnSync({
      cmd: [cmd, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      return { kind: "failed" };
    }
    return { kind: "ok", stdout: new TextDecoder().decode(result.stdout) };
  } catch (error) {
    return spawnErrorCode(error) === NOT_FOUND
      ? { kind: "missing" }
      : { kind: "failed" };
  }
}

/**
 * `<root>` for the apt-source and apt-key lookups (contract "Package drift"):
 * `DRIFT_ROOT` when set and not empty, `/` otherwise. A test points it at a
 * temp folder; on a real machine the default reads the real `/etc` and
 * `/usr/share/keyrings`.
 */
export function driftRoot(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env.DRIFT_ROOT;
  return value === undefined || value === "" ? "/" : value;
}

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
  return sorted.filter(
    (name, index) => index === 0 || name !== sorted[index - 1],
  );
}

/** A manager that could not answer, with the contract's note. */
function skipped(note: string): ManagerResult {
  return { skipped: note };
}

/** The first whitespace-separated field of a line, as awk's `$1`. */
function firstWord(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

/** `apt-mark`'s `:arch` suffix dropped, as `awk -F:` does. */
function withoutArch(name: string): string {
  const colon = name.indexOf(ARCH_SEPARATOR);
  return colon === -1 ? name : name.slice(0, colon);
}

/** Everything directly inside `dir`, or none when it is missing or unreadable. */
function namesIn(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Entries directly inside `dir`, minus dotfiles, which the bash glob skips. */
function visibleNames(dir: string): readonly string[] {
  return namesIn(dir).filter((name) => !name.startsWith("."));
}

/** `[[ -d path ]]`, following symlinks as bash's test does. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `[[ -f path ]]`, following symlinks as bash's test does. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file's bytes, or none when it cannot be read; the content check counts an
 * unreadable file as not installed. */
function readBytes(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/** A text file's content, or none when it is missing or unreadable. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A `PackageFile`; `content` is left out when the file cannot be read. */
function packageFile(path: string, name: string): PackageFile {
  const content = readBytes(path);
  return content === undefined ? { name } : { name, content };
}

/** The regular files directly in `dir` whose name `accept` keeps, C-sorted. */
function filesIn(
  dir: string,
  accept: (name: string) => boolean,
): PackageFile[] {
  return visibleNames(dir)
    .filter(accept)
    .filter((name) => isFile(join(dir, name)))
    .sort(compareC)
    .map((name) => packageFile(join(dir, name), name));
}

/** Folders directly inside `dir`, as `drift_folders` lists them. */
function folderNames(dir: string): string[] {
  return uniqueSorted(
    visibleNames(dir).filter((name) => isDirectory(join(dir, name))),
  );
}

/** `npm_packages`: one `@scope/name` per scoped package, one name per plain
 * package, and no dotfiles. npm itself is never called. */
function npmPackages(nodeDir: string): string[] {
  const packages: string[] = [];
  for (const name of visibleNames(nodeDir)) {
    const path = join(nodeDir, name);
    if (!isDirectory(path)) {
      continue;
    }
    if (!name.startsWith("@")) {
      packages.push(name);
      continue;
    }
    for (const sub of visibleNames(path)) {
      if (isDirectory(join(path, sub))) {
        packages.push(`${name}/${sub}`);
      }
    }
  }
  return uniqueSorted(packages);
}

/** Digit and non-digit runs, alternating from the start. */
function versionParts(value: string): string[] {
  return value.match(/\d+|\D+/g) ?? [];
}

/** Two digit runs by value, ignoring leading zeros. */
function compareNumbers(left: string, right: string): number {
  const a = left.replace(/^0+/, "") || "0";
  const b = right.replace(/^0+/, "") || "0";
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `sort -V`'s order: digit runs numerically, everything else by byte. */
function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const shared = Math.min(leftParts.length, rightParts.length);
  for (let i = 0; i < shared; i++) {
    const a = leftParts[i] ?? "";
    const b = rightParts[i] ?? "";
    const aIsNumber = /^\d+$/.test(a);
    const bIsNumber = /^\d+$/.test(b);
    const difference =
      aIsNumber && bIsNumber ? compareNumbers(a, b) : compareC(a, b);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftParts.length - rightParts.length;
}

/** `sort -V`'s order, with byte order breaking an exact tie. */
function versionOrder(left: string, right: string): number {
  const difference = compareVersions(left, right);
  return difference === 0 ? compareC(left, right) : difference;
}

/** The newest version folder, as `sort -V | tail -n 1` picks it. */
function newestVersion(dir: string): string | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let newest: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (newest === undefined || versionOrder(entry.name, newest) > 0) {
      newest = entry.name;
    }
  }
  return newest;
}

/** Two `dpkg-query` sources for apt: present from statuses, chosen from
 * `apt-mark showmanual`. The bash order is kept: a failed dpkg-query never
 * reaches apt-mark. */
function aptInstalled(run: Run): ManagerResult {
  const query = run("dpkg-query", ["-W", DPKG_FORMAT]);
  if (query.kind === "missing") {
    return skipped("dpkg-query not installed");
  }
  if (query.kind === "failed") {
    return skipped("dpkg-query failed");
  }
  const present = uniqueSorted(
    query.stdout.split("\n").flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const status = fields[0];
      const name = fields[1];
      return status === "installed" && name !== undefined ? [name] : [];
    }),
  );

  const manual = run("apt-mark", ["showmanual"]);
  if (manual.kind === "missing") {
    return skipped("apt-mark not installed");
  }
  if (manual.kind === "failed") {
    return skipped("apt-mark failed");
  }
  const chosen = uniqueSorted(
    manual.stdout
      .split("\n")
      .map(firstWord)
      .filter((name) => name !== "")
      .map(withoutArch),
  );
  return { present, chosen };
}

/** `snap list`, without the header and the base/snapd rows. */
function snapInstalled(run: Run): ManagerResult {
  const result = run("snap", ["list"]);
  if (result.kind === "missing") {
    return skipped("snap not installed");
  }
  if (result.kind === "failed") {
    return skipped("snap failed");
  }
  const present = uniqueSorted(
    result.stdout.split("\n").flatMap((line, index) => {
      if (index === 0) {
        return [];
      }
      const fields = line.trim().split(/\s+/).filter((field) => field !== "");
      const notes = fields[fields.length - 1];
      const name = fields[0];
      if (name === undefined || notes === undefined) {
        return [];
      }
      return SNAP_INFRASTRUCTURE.test(notes) ? [] : [name];
    }),
  );
  return { present, chosen: present };
}

/** The newest nvm version's `lib/node_modules` folders; a missing nvm folder
 * is `nvm not installed`, as bash reports it. */
function npmInstalled(home: string): ManagerResult {
  const versions = join(home, ...NVM_VERSIONS);
  const newest = newestVersion(versions);
  if (newest === undefined) {
    return skipped("nvm not installed");
  }
  const present = npmPackages(join(versions, newest, "lib", "node_modules"));
  return { present, chosen: present };
}

/** `pipx list --short`, first field of each line. */
function pipxInstalled(run: Run): ManagerResult {
  const result = run("pipx", ["list", "--short"]);
  if (result.kind === "missing") {
    return skipped("pipx not installed");
  }
  if (result.kind === "failed") {
    return skipped("pipx failed");
  }
  const present = uniqueSorted(result.stdout.split("\n").map(firstWord));
  return { present, chosen: present };
}

/** `code --list-extensions`, one extension per line. */
function vscodeInstalled(run: Run): ManagerResult {
  const result = run("code", ["--list-extensions"]);
  if (result.kind === "missing") {
    return skipped("code not installed");
  }
  if (result.kind === "failed") {
    return skipped("code failed");
  }
  const present = uniqueSorted(result.stdout.split("\n"));
  return { present, chosen: present };
}

/** A folder-backed manager: the folder names are both present and chosen, and
 * a missing folder means nothing is installed, not `SKIPPED`. */
function folderInstalled(dir: string): ManagerResult {
  const present = folderNames(dir);
  return { present, chosen: present };
}

/** A repo or system file is a source when its name has a source extension. */
function isSourceName(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** The system keyrings, `usr/share/keyrings` before `etc/apt/keyrings`, so a
 * name in both keeps the copy bash finds first. */
function systemKeys(root: string): PackageFile[] {
  const seen = new Set<string>();
  const files: PackageFile[] = [];
  for (const folder of [SHARED_KEYRINGS, LOCAL_KEYRINGS]) {
    for (const file of filesIn(join(root, ...folder), (name) =>
      name.endsWith(KEY_EXTENSION),
    )) {
      if (seen.has(file.name)) {
        continue;
      }
      seen.add(file.name);
      files.push(file);
    }
  }
  return files.sort((left, right) => compareC(left.name, right.name));
}

/**
 * The contract's system side: what this machine's managers report. The tool
 * calls run in the contract's order (apt, snap, npm, pipx, vscode, font,
 * extension, apt-source, apt-key); a failing tool only skips its own manager.
 * `root` is `<root>` of the apt-source and apt-key rows (`DRIFT_ROOT`).
 */
export function readInstalled(input: InstalledInput): Installed {
  const run = input.run ?? runCommand;
  return {
    apt: aptInstalled(run),
    snap: snapInstalled(run),
    npm: npmInstalled(input.home),
    pipx: pipxInstalled(run),
    vscode: vscodeInstalled(run),
    font: folderInstalled(join(input.home, ...FONT_FOLDER)),
    extension: folderInstalled(join(input.home, ...EXTENSION_FOLDER)),
    "apt-source": {
      files: filesIn(join(input.root, ...SOURCES_FOLDER), () => true),
    },
    "apt-key": { files: systemKeys(input.root) },
  };
}

/**
 * The repo side: the text of each `packages/linux/` list and the content of
 * its `apt-sources/` and `keyrings/` files, in the shape `parsePackageLists`
 * reads. A missing or unreadable file is left out, as `package_names` treats
 * it as empty.
 */
export function readPackageLists(folder: string): PackageListTexts {
  const texts: { -readonly [K in ListTextField]?: string } & {
    sources?: readonly PackageFile[];
    keys?: readonly PackageFile[];
  } = {};
  for (const [field, file] of LIST_TEXTS) {
    const content = readText(join(folder, file));
    if (content !== undefined) {
      texts[field] = content;
    }
  }
  const sources = filesIn(join(folder, "apt-sources"), isSourceName);
  if (sources.length > 0) {
    texts.sources = sources;
  }
  const keys = filesIn(join(folder, "apt-sources", "keyrings"), (name) =>
    name.endsWith(KEY_EXTENSION),
  );
  if (keys.length > 0) {
    texts.keys = keys;
  }
  return texts;
}

/**
 * The lines of `packages/linux/drift-ignore.txt`: `<manager> <name>` entries.
 * The core parses them; blank lines are dropped and a missing file gives none.
 */
export function readDriftIgnore(folder: string): readonly string[] {
  const text = readText(join(folder, "drift-ignore.txt"));
  if (text === undefined) {
    return [];
  }
  return text.split("\n").filter((line) => line.trim() !== "");
}
