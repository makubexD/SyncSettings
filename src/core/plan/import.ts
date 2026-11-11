import { same } from "../compare.ts";
import type { ConfigV2Entry, Os, SanitizeRule } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import type { SelectedEntry } from "../layers/select.ts";
import { formatLine } from "../status.ts";
import type { StatusWord } from "../status.ts";
import { hydrate, inferValues, resolveValues } from "../values/hydrate.ts";
import type { Values } from "../values/sanitize.ts";
import type { Action, Plan, Snapshot } from "./types.ts";

const BASE_ROOT = "dotfiles/common/";

const EXCLUDE_NOTE = "matches exclude pattern";

const REPO_MISSING_NOTE = "not found in repo";

const USER_SKIPPED_NOTE = "user skipped";

const EXTRA_NOTE = "not in repo; kept";

const SYMLINK_NOTE = "symlink";

const DCONF_NOTE = "not supported yet";

const ONLY_WARNING = "  WARNING: --only matched no file.";

const DASHES = "  --------------------------------------------------";

const SYNC_POINT_FILE = "last-sync";

const SYNC_POINT_SHOWN = 7;

// The helper block below (path expansion, exclude matching and --only
// resolution) is copied from export.ts so this step needs no change there.
// shortcut: a later step extracts these shared helpers into one module.
function separatorFor(os: Os): "/" | "\\" {
  return os === "windows" ? "\\" : "/";
}

function otherSeparator(separator: "/" | "\\"): string {
  return separator === "/" ? "\\" : "/";
}

function joinPath(base: string, tail: string, separator: "/" | "\\"): string {
  if (base === "") {
    return tail;
  }
  if (tail === "") {
    return base;
  }
  return base.endsWith(separator) ? `${base}${tail}` : `${base}${separator}${tail}`;
}

/** `~/` (or `~\`) becomes the home folder; elsewhere `\` becomes `/` on Windows. */
function expandHome(raw: string, os: Os, home: string): string {
  const separator = separatorFor(os);
  if (raw === "~") {
    return home;
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    const tail = raw.slice(2).replaceAll(otherSeparator(separator), separator);
    return joinPath(home, tail, separator);
  }
  return raw.replaceAll(otherSeparator(separator), separator);
}

/** The entry's local path on this system, `localPaths` first (contract "`localPath`"). */
function resolvedLocal(entry: ConfigV2Entry, os: Os, home: string): string {
  const raw = entry.localPaths?.[os] ?? entry.localPath ?? "";
  return expandHome(raw, os, home);
}

function isAbsolutePath(path: string, separator: "/" | "\\"): boolean {
  if (separator === "/") {
    return path.startsWith("/");
  }
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\");
}

/** `normalize_path` in `scripts/linux/sync.sh`, lexically and without links. */
function normalizePath(path: string, separator: "/" | "\\"): string {
  const unified = path.replaceAll(otherSeparator(separator), separator);
  let prefix = "";
  let rest = unified;
  if (separator === "\\" && /^[A-Za-z]:/.test(unified)) {
    prefix = `${unified.slice(0, 2)}${separator}`;
    rest = unified.slice(2);
  } else if (unified.startsWith(separator)) {
    prefix = separator;
    rest = unified.slice(1);
  }
  const parts: string[] = [];
  for (const part of rest.split(separator)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join(separator)}`;
}

function absoluteLocal(raw: string, snapshot: Snapshot): string {
  const separator = separatorFor(snapshot.os);
  let path = raw;
  if (path === "~") {
    path = snapshot.home;
  } else if (path.startsWith("~/") || path.startsWith("~\\")) {
    path = joinPath(snapshot.home, path.slice(2), separator);
  }
  if (!isAbsolutePath(path, separator)) {
    path = joinPath(snapshot.cwd, path, separator);
  }
  return normalizePath(path, separator);
}

/** The entry's repo path: the layer that holds it, else decision 3's root. */
function primaryRepoPath(selected: SelectedEntry): string {
  return selected.source?.repoPath ?? `${selected.writeRoot}${selected.entry.file}`;
}

function onlySelected(repoPath: string, only: readonly string[]): boolean {
  if (only.length === 0) {
    return true;
  }
  return only.some(
    (picked) =>
      repoPath === picked ||
      repoPath.startsWith(`${picked}/`) ||
      repoPath.startsWith(`${picked}.linked/`),
  );
}

function entrySelected(selected: SelectedEntry, only: readonly string[]): boolean {
  if (only.length === 0) {
    return true;
  }
  const repoPath = primaryRepoPath(selected);
  if (onlySelected(repoPath, only)) {
    return true;
  }
  return only.some(
    (picked) =>
      picked.startsWith(`${repoPath}/`) ||
      picked.startsWith(`${repoPath}.linked/`),
  );
}

function onlyFailure(argument: string): Plan {
  return {
    actions: [],
    lines: [`ERROR: ${argument} is not synced on this machine.`],
    code: 1,
  };
}

/** Contract "Picking files": turn every `--only` path into the repo path it names. */
function resolveOnly(snapshot: Snapshot, selected: readonly SelectedEntry[]): OnlyOutcome {
  const paths: string[] = [];
  for (const argument of snapshot.only) {
    let path = argument;
    while (path.endsWith("/") && path !== "/") {
      path = path.slice(0, -1);
    }

    if (path.startsWith("dotfiles/")) {
      if (`/${path}/`.includes("/../") || path.includes(".linked/")) {
        return { ok: false, plan: onlyFailure(argument) };
      }
      const found = selected.some((entry) => {
        const repoPath = primaryRepoPath(entry);
        return path === repoPath || (entry.entry.merge === "dir" && path.startsWith(`${repoPath}/`));
      });
      if (!found) {
        return { ok: false, plan: onlyFailure(argument) };
      }
      paths.push(path);
      continue;
    }

    const absolute = absoluteLocal(path, snapshot);
    const separator = separatorFor(snapshot.os);
    let repoPath: string | undefined;
    for (const entry of selected) {
      if (entry.entry.merge === "dconf") {
        continue;
      }
      const local = normalizePath(
        resolvedLocal(entry.entry, snapshot.os, snapshot.home),
        separator,
      );
      if (entry.entry.merge !== "dir" && absolute === local) {
        repoPath = primaryRepoPath(entry);
        break;
      }
      if (entry.entry.merge === "dir" && absolute.startsWith(`${local}${separator}`)) {
        const rest = absolute
          .slice(local.length + 1)
          .replaceAll(separator, "/");
        repoPath = `${primaryRepoPath(entry)}/${rest}`;
        break;
      }
    }
    if (repoPath === undefined) {
      return { ok: false, plan: onlyFailure(argument) };
    }
    paths.push(repoPath);
  }
  return { ok: true, paths };
}

function regexEscape(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

/** A bash-style glob: `*`, `?` and a bracket class. */
function globSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === undefined) {
      break;
    }
    if (character === "*") {
      source += ".*";
      continue;
    }
    if (character === "?") {
      source += ".";
      continue;
    }
    if (character === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      let negated = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negated = true;
        body = body.slice(1);
      }
      source += `[${negated ? "^" : ""}${body.replaceAll("\\", "\\\\")}]`;
      i = end;
      continue;
    }
    if (character === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        source += "\\\\";
      } else {
        source += regexEscape(next);
        i++;
      }
      continue;
    }
    source += regexEscape(character);
  }
  return source;
}

function globMatches(text: string, pattern: string, caseInsensitive: boolean): boolean {
  return new RegExp(`^${globSource(pattern)}$`, caseInsensitive ? "i" : "").test(text);
}

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Contract "Exclude patterns": the file name, or the end of the path. */
function isExcluded(snapshot: Snapshot, path: string): boolean {
  const patterns = snapshot.config.excludePatterns ?? [];
  if (patterns.length === 0) {
    return false;
  }
  const caseInsensitive = snapshot.os === "windows";
  const leaf = basename(path);
  return patterns.some((pattern) => {
    if (pattern === "") {
      return false;
    }
    return (
      globMatches(leaf, pattern, caseInsensitive) ||
      globMatches(path, `*/${pattern}`, caseInsensitive) ||
      globMatches(path, `*\\${pattern}`, caseInsensitive)
    );
  });
}

// The copied helper block ends here.

type OnlyOutcome =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly plan: Plan };

interface State {
  readonly snapshot: Snapshot;
  readonly values: Values;
  readonly only: readonly string[];
  readonly answers: readonly string[];
  readonly force: boolean;
  readonly actions: Action[];
  readonly lines: string[];
  answerIndex: number;
  applied: number;
  skipped: number;
  errors: number;
  userSkips: number;
  hits: number;
  readonly createdDirs: Set<string>;
}

function pushStatus(
  state: State,
  word: StatusWord,
  label: string,
  note?: string,
): void {
  state.lines.push(formatLine(word, label, note));
  state.hits++;
  if (word === "ERROR") {
    state.errors++;
  }
  if (word === "SKIPPED" && note === USER_SKIPPED_NOTE) {
    state.userSkips++;
  }
}

function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:$/.test(path);
}

/** `mkdir -p` the file's folder when the snapshot doesn't list it (decision 4). */
function ensureParentDir(state: State, path: string): void {
  const separator = separatorFor(state.snapshot.os);
  const slash = path.lastIndexOf(separator);
  if (slash <= 0) {
    return;
  }
  const parent = path.slice(0, slash);
  if (isDriveRoot(parent)) {
    return;
  }
  if (state.snapshot.localDirs.has(parent) || state.createdDirs.has(parent)) {
    return;
  }
  state.createdDirs.add(parent);
  state.actions.push({ kind: "mkdir", path: parent });
}

/** Contract "Overwrite prompt": an empty answer and end of input both mean yes. */
function overwriteAccepted(state: State): boolean {
  if (state.force) {
    return true;
  }
  const answer = state.answers[state.answerIndex];
  state.answerIndex++;
  if (answer === undefined) {
    return true;
  }
  const trimmed = answer.trim();
  if (trimmed === "") {
    return true;
  }
  return /^[Yy]/.test(trimmed);
}

function writeCreated(state: State, label: string, localPath: string, bytes: Uint8Array): void {
  // shortcut: the snapshot has no repo file modes, so a created file gets the
  // adapter's default mode instead of copying the repo file's (`cp -p`).
  state.actions.push({ kind: "writeLocal", path: localPath, bytes });
  pushStatus(state, "CREATED", label);
  state.applied++;
}

function writeUpdated(state: State, label: string, localPath: string, bytes: Uint8Array): void {
  state.actions.push({ kind: "backup", path: localPath });
  state.actions.push({ kind: "writeLocal", path: localPath, bytes });
  pushStatus(state, "UPDATED", label, `backup saved as ${basename(localPath)}.bak`);
  state.applied++;
}

/** Compare a repo side with the local file, then prompt, back up and write. */
function applyBytes(
  state: State,
  label: string,
  localPath: string,
  repoPath: string,
  bytes: Uint8Array,
  sanitized: boolean,
): void {
  const local = state.snapshot.localFiles.get(localPath);
  if (local !== undefined && local.kind === "symlink") {
    pushStatus(state, "SKIPPED", label, SYMLINK_NOTE);
    return;
  }

  if (local !== undefined) {
    const equal = same(bytes, local.bytes, {
      os: state.snapshot.os,
      shared: repoPath.startsWith(BASE_ROOT),
      sanitized,
    });
    if (equal) {
      pushStatus(state, "UNCHANGED", label);
      return;
    }
    if (!overwriteAccepted(state)) {
      pushStatus(state, "SKIPPED", label, USER_SKIPPED_NOTE);
      state.skipped++;
      return;
    }
    writeUpdated(state, label, localPath, bytes);
    return;
  }

  writeCreated(state, label, localPath, bytes);
}

function planFile(state: State, selected: SelectedEntry): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }

  const localPath = resolvedLocal(entry, state.snapshot.os, state.snapshot.home);
  if (isExcluded(state.snapshot, localPath)) {
    pushStatus(state, "SKIPPED", repoPath, EXCLUDE_NOTE);
    return;
  }

  const source = selected.source;
  const bytes = source === undefined ? undefined : state.snapshot.repoFiles.get(source.repoPath);
  if (source === undefined || bytes === undefined) {
    pushStatus(state, "SKIPPED", repoPath, REPO_MISSING_NOTE);
    state.skipped++;
    return;
  }

  ensureParentDir(state, localPath);

  const rules = entry.sanitize ?? [];
  if (rules.length === 0) {
    applyBytes(state, repoPath, localPath, repoPath, bytes, false);
    return;
  }

  const hydrated = hydrate(bytes, rules, state.values, {
    json: entry.file.endsWith(".json"),
  });
  if (!hydrated.ok) {
    // Unreachable after resolveValues; an ERROR only affects this file.
    pushStatus(state, "ERROR", repoPath, hydrated.error.message);
    return;
  }
  applyBytes(state, repoPath, localPath, repoPath, hydrated.value, true);
}

function planDir(state: State, selected: SelectedEntry): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  const separator = separatorFor(state.snapshot.os);
  const localDir = resolvedLocal(entry, state.snapshot.os, state.snapshot.home);
  const source = selected.source;

  if (source === undefined) {
    pushStatus(state, "SKIPPED", `${repoPath}/`, REPO_MISSING_NOTE);
    state.skipped++;
    return;
  }

  const repoPrefix = `${source.repoPath}/`;
  const repoNames = [...state.snapshot.repoFiles.keys()]
    .filter((path) => path.startsWith(repoPrefix))
    .sort();

  for (const repoName of repoNames) {
    const relative = repoName.slice(repoPrefix.length);
    const label = `${repoPath}/${relative}`;
    if (!onlySelected(label, state.only)) {
      continue;
    }
    const localPath = joinPath(localDir, relative.replaceAll("/", separator), separator);
    if (isExcluded(state.snapshot, localPath)) {
      pushStatus(state, "SKIPPED", label, EXCLUDE_NOTE);
      continue;
    }
    const bytes = state.snapshot.repoFiles.get(repoName);
    if (bytes === undefined) {
      continue;
    }
    ensureParentDir(state, localPath);
    applyBytes(state, label, localPath, repoName, bytes, false);
  }

  // Import never deletes: a local file the repo doesn't have is EXTRA and kept.
  const localPrefix = `${localDir}${separator}`;
  const localPaths = [...state.snapshot.localFiles.keys()]
    .filter((path) => path.startsWith(localPrefix))
    .sort();
  for (const localPath of localPaths) {
    const local = state.snapshot.localFiles.get(localPath);
    if (local === undefined || local.kind !== "file") {
      continue;
    }
    const relative = localPath.slice(localPrefix.length).replaceAll(separator, "/");
    const label = `${repoPath}/${relative}`;
    if (!onlySelected(label, state.only)) {
      continue;
    }
    if (state.snapshot.repoFiles.has(`${source.repoPath}/${relative}`)) {
      continue;
    }
    if (isExcluded(state.snapshot, localPath)) {
      continue;
    }
    pushStatus(state, "EXTRA", label, EXTRA_NOTE);
  }
}

function planDconf(state: State, selected: SelectedEntry): void {
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }
  pushStatus(state, "SKIPPED", repoPath, DCONF_NOTE);
  state.skipped++;
}

/** The state file of contract "Sync point" for this OS. */
function lastSyncFile(snapshot: Snapshot): string {
  const separator = separatorFor(snapshot.os);
  if (snapshot.os === "windows") {
    const localAppData = snapshot.env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData !== ""
        ? localAppData
        : joinPath(snapshot.home, `AppData${separator}Local`, separator);
    return joinPath(joinPath(base, "SyncSettings", separator), SYNC_POINT_FILE, separator);
  }
  const stateHome = snapshot.env.XDG_STATE_HOME;
  const base =
    stateHome !== undefined && stateHome !== ""
      ? stateHome
      : joinPath(snapshot.home, `.local${separator}state`, separator);
  return joinPath(joinPath(base, "sync-settings", separator), SYNC_POINT_FILE, separator);
}

/** Contract "Sync point": every condition must hold before HEAD is recorded. */
function shouldRecordSyncPoint(state: State): boolean {
  if (state.only.length > 0) {
    return false;
  }
  if (state.errors > 0) {
    return false;
  }
  if (state.userSkips > 0) {
    return false;
  }
  const head = state.snapshot.head;
  if (head === undefined || head === "") {
    return false;
  }
  return state.snapshot.porcelain === "";
}

function summaryLines(state: State, syncPoint: string | undefined): readonly string[] {
  const lines: string[] = [];
  if (state.only.length > 0 && state.hits === 0) {
    lines.push(ONLY_WARNING);
  }
  lines.push("");
  lines.push(DASHES);
  lines.push("");
  lines.push(`  ${state.applied} file(s) applied.`);
  lines.push("");
  if (syncPoint !== undefined) {
    lines.push(`  Sync point : ${syncPoint.slice(0, SYNC_POINT_SHOWN)}`);
    lines.push("");
  }
  lines.push(DASHES);
  lines.push("");
  return lines;
}

function collectRules(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
  only: readonly string[],
): { readonly rules: readonly SanitizeRule[]; readonly inferred: Values } {
  const rules: SanitizeRule[] = [];
  const inferred = new Map<string, string>();

  for (const entry of selected) {
    if (!entrySelected(entry, only)) {
      continue;
    }
    if (entry.entry.merge === "dir" || entry.entry.merge === "dconf") {
      continue;
    }
    const entryRules = entry.entry.sanitize ?? [];
    if (entryRules.length === 0) {
      continue;
    }
    const source = entry.source;
    const repoBytes = source === undefined ? undefined : snapshot.repoFiles.get(source.repoPath);
    if (repoBytes === undefined) {
      continue;
    }
    rules.push(...entryRules);

    const localPath = resolvedLocal(entry.entry, snapshot.os, snapshot.home);
    const local = snapshot.localFiles.get(localPath);
    if (local === undefined || local.kind !== "file") {
      continue;
    }
    for (const [placeholder, value] of Object.entries(
      inferValues(local.bytes, repoBytes, entryRules),
    )) {
      if (!inferred.has(placeholder)) {
        inferred.set(placeholder, value);
      }
    }
  }

  return { rules, inferred: Object.fromEntries(inferred) };
}

/**
 * The import plan: every status line, action and the exit code the contract
 * gives import, from a snapshot, the `--force` flag and the prompt answers.
 */
export function planImport(
  snapshot: Snapshot,
  answers: readonly string[],
): Plan {
  const selected = selectEntries(
    snapshot.config,
    snapshot.os,
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return { actions: [], lines: [selected.error.message], code: selected.error.code };
  }

  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return only.plan;
  }

  const gathered = collectRules(snapshot, selected.value, only.paths);
  const values = resolveValues(gathered.rules, snapshot.values, gathered.inferred, snapshot.env);
  if (!values.ok) {
    return { actions: [], lines: [values.error.message], code: 1 };
  }

  const state: State = {
    snapshot,
    values: values.value,
    only: only.paths,
    answers,
    force: snapshot.force === true,
    actions: [],
    lines: [],
    answerIndex: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    userSkips: 0,
    hits: 0,
    createdDirs: new Set<string>(),
  };

  for (const entry of selected.value) {
    if (!entrySelected(entry, only.paths)) {
      continue;
    }
    switch (entry.entry.merge) {
      case "dir":
        planDir(state, entry);
        break;
      case "dconf":
        planDconf(state, entry);
        break;
      default:
        planFile(state, entry);
        break;
    }
  }

  let syncPoint: string | undefined;
  if (shouldRecordSyncPoint(state)) {
    syncPoint = snapshot.head;
    if (syncPoint !== undefined) {
      state.actions.push({
        kind: "writeState",
        path: lastSyncFile(snapshot),
        text: `${syncPoint}\n`,
      });
    }
  }

  state.lines.push(...summaryLines(state, syncPoint));
  return { actions: state.actions, lines: state.lines, code: 0 };
}
