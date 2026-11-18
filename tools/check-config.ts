// Dev-only: checks sync-config.json against the files in the repo. Never compiled into the program.
import { existsSync, readdirSync } from "node:fs";
import type { ConfigV2, ConfigV2Entry, Os } from "../src/core/config/types.ts";
import { parseV2 } from "../src/core/config/v2.ts";

const CONFIG_SOURCE = "sync-config.json";

const DOTFILES = "dotfiles";

const BASE_ROOT = "dotfiles/common/";

const ALL_OS: readonly Os[] = ["windows", "linux", "macos"];

function effectiveOs(config: ConfigV2, entry: ConfigV2Entry): readonly Os[] {
  return entry.os ?? config.modules[entry.module]?.os ?? ALL_OS;
}

/** The layer roots an entry may hold its file in: the base and each OS layer. */
function rootsFor(os: readonly Os[]): readonly string[] {
  return [BASE_ROOT, ...os.map((system) => `dotfiles/${system}/`)];
}

/** Where an entry's file is written when it is new. */
function writeRootFor(os: readonly Os[]): string {
  const [only] = os;
  return os.length === 1 && only !== undefined ? `dotfiles/${only}/` : BASE_ROOT;
}

/** Every file under `folder`, by forward-slash path relative to the repo. */
function repoFiles(folder: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...repoFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

const parsed = parseV2(await Bun.file(CONFIG_SOURCE).text());
if (!parsed.ok) {
  console.error(parsed.error.message);
  process.exit(parsed.error.code);
}

const config = parsed.value;
const problems: string[] = [];

const ownedFiles = new Set<string>();
const ownedFolders: string[] = [];
const linkedFolders: string[] = [];

for (const entry of config.entries) {
  const os = effectiveOs(config, entry);
  for (const root of rootsFor(os)) {
    const repoPath = `${root}${entry.file}`;
    if (entry.merge === "dir") {
      ownedFolders.push(`${repoPath}/`);
    } else {
      ownedFiles.add(repoPath);
    }
    if (entry.scanLinks === true) {
      linkedFolders.push(`${repoPath}.linked/`);
    }
  }
  const primary = `${writeRootFor(os)}${entry.file}`;
  if (!existsSync(primary)) {
    problems.push(`${primary}: no such file for entry ${entry.file}`);
  }
}

for (const path of repoFiles(DOTFILES).sort()) {
  const owned =
    ownedFiles.has(path) ||
    ownedFolders.some((folder) => path.startsWith(folder)) ||
    linkedFolders.some((folder) => path.startsWith(folder));
  if (!owned) {
    problems.push(`${path}: no config entry covers this file`);
  }
}

for (const problem of problems) {
  console.error(problem);
}
if (problems.length > 0) {
  process.exit(1);
}
process.stdout.write("config v2 OK\n");
