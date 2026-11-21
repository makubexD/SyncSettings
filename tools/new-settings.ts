// Dev-only: lists the settings a sync PR adds, comparing its head with its
// base (contract "New settings" in docs/review-gate.md). Never compiled into
// the program.
const USAGE = "bun tools/new-settings.ts <base-ref> <head-ref>";

const HEADING = "New settings in this PR";

const CONFIG_PATH = "sync-config.json";

/** The folders whose files count as settings. */
const SETTING_FOLDERS = ["dotfiles/", "profiles/", "machines/"];

/** Every path and needed file text of one ref's tree. */
export interface TreeSnapshot {
  readonly paths: ReadonlySet<string>;
  readonly contents: ReadonlyMap<string, string>;
}

/** A failed `git` run, with git's own message as the reason. */
class GitFailure extends Error {}

function isUnderFolders(path: string): boolean {
  return SETTING_FOLDERS.some((folder) => path.startsWith(folder));
}

/** A file whose contents the diff needs: the config or a JSON setting file. */
function isSettingFile(path: string): boolean {
  return (
    path === CONFIG_PATH || (path.endsWith(".json") && isUnderFolders(path))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `file` values of a config's entries; none when it is missing or broken. */
function entryFiles(tree: TreeSnapshot): readonly string[] {
  const text = tree.contents.get(CONFIG_PATH);
  if (text === undefined) {
    return [];
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(config) || !Array.isArray(config.entries)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of config.entries) {
    if (isRecord(entry) && typeof entry.file === "string") {
      files.push(entry.file);
    }
  }
  return files;
}

/** Every dotted key path of a JSON object, objects followed key by key. */
function collectKeyPaths(
  value: unknown,
  prefix: string,
  out: Set<string>,
): void {
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out.add(path);
    collectKeyPaths(item, path, out);
  }
}

/** A JSON text's key paths; undefined when the text does not parse. */
function keyPaths(text: string): ReadonlySet<string> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const paths = new Set<string>();
  collectKeyPaths(value, "", paths);
  return paths;
}

/** The `entry`, `file` and `key` lines the head tree adds over the base. */
export function newSettings(
  base: TreeSnapshot,
  head: TreeSnapshot,
): readonly string[] {
  const lines = new Set<string>();

  const baseEntries = new Set(entryFiles(base));
  for (const file of entryFiles(head)) {
    if (!baseEntries.has(file)) {
      lines.add(`entry ${file}`);
    }
  }

  for (const path of head.paths) {
    if (isUnderFolders(path) && !base.paths.has(path)) {
      lines.add(`file ${path}`);
    }
  }

  for (const path of head.paths) {
    if (!isUnderFolders(path) || !path.endsWith(".json")) {
      continue;
    }
    if (!base.paths.has(path)) {
      continue;
    }
    const beforeText = base.contents.get(path);
    const afterText = head.contents.get(path);
    if (beforeText === undefined || afterText === undefined) {
      continue;
    }
    const before = keyPaths(beforeText);
    const after = keyPaths(afterText);
    if (before === undefined || after === undefined) {
      continue;
    }
    for (const key of after) {
      if (!before.has(key)) {
        lines.add(`key ${path}: ${key}`);
      }
    }
  }

  return [...lines].sort();
}

/** The comment body: the heading, a blank line, then the settings or none. */
export function renderComment(lines: readonly string[]): string {
  if (lines.length === 0) {
    return `${HEADING}\n\nNo new settings.\n`;
  }
  const list = lines.map((line) => `${line}\n`).join("");
  return `${HEADING}\n\n${list}`;
}

function runGit(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const reason = result.stderr.toString().trim();
    throw new GitFailure(
      reason === ""
        ? `git ${args.join(" ")} failed (exit ${result.exitCode ?? "unknown"})`
        : reason,
    );
  }
  return result.stdout.toString();
}

/** Every path and setting-file text of one ref's tree. */
function readTree(ref: string): TreeSnapshot {
  const paths = new Set(
    // -z: NUL-separated and never quoted, so unusual names come through as is.
    runGit(["ls-tree", "-r", "-z", "--name-only", ref])
      .split("\0")
      .filter((line) => line !== ""),
  );
  const contents = new Map<string, string>();
  for (const path of paths) {
    if (isSettingFile(path)) {
      contents.set(path, runGit(["show", `${ref}:${path}`]));
    }
  }
  return { paths, contents };
}

export function main(argv: readonly string[]): number {
  const [baseRef, headRef] = argv;
  if (argv.length !== 2 || baseRef === undefined || headRef === undefined) {
    console.error(`usage: ${USAGE}`);
    return 2;
  }
  try {
    const lines = newSettings(readTree(baseRef), readTree(headRef));
    process.stdout.write(renderComment(lines));
    return 0;
  } catch (error) {
    if (error instanceof GitFailure) {
      console.error(`ERROR: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
