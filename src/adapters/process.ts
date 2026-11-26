/**
 * The process adapter: run commands, find them on `PATH` and read stdin. It
 * sits on `node:child_process`, `node:fs` and `node:path`, so the same module
 * serves Bun and Node; no Bun-only API may appear here.
 *
 * Failure is a result, never an exception: a missing command, a timeout and a
 * death by signal are codes the contract can print.
 */

import { spawn, spawnSync } from "node:child_process";
import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
} from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  statSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { join, posix, win32 } from "node:path";
import { createInterface } from "node:readline";

/** A command that is not there, as a shell reports it and the contract prints it. */
const MISSING_CODE = 127;

/** The child ran past `timeoutMs` and was killed. */
const TIMEOUT_CODE = 124;

/** The child could not start for any reason other than a missing command. */
const SPAWN_FAILED_CODE = 126;

/** A child stopped by a signal reports 128 plus the signal's number. */
const SIGNAL_EXIT_OFFSET = 128;

/** The spawn error code for a command that does not exist. */
const NOT_FOUND = "ENOENT";

/** The `spawnSync` error code for a run that hit its `timeout`. */
const TIMED_OUT = "ETIMEDOUT";

/** How a timed-out child is stopped; SIGTERM lets it ignore the deadline. */
const KILL_SIGNAL = "SIGKILL";

/** The suffixes `spawn` starts by itself on Windows, in the order libuv tries
 * them. A `.cmd` or `.bat` needs cmd.exe, whose quoting is unsafe for free
 * text such as a PR body, so the program never runs one (contract "The
 * program"): neither counts as found. */
const WINDOWS_SUFFIXES: readonly string[] = [".com", ".exe"];

/** Decided once: on Windows a command may be `name.EXE`, and suffix matching
 * ignores case. */
const IS_WINDOWS = process.platform === "win32";

/** The quote a Windows PATH folder may be wrapped in. */
const PATH_QUOTE = '"';

/** A quoted folder holds at least its two quotes. */
const QUOTED_MIN_LENGTH = 2;

/** The byte order mark Windows PowerShell puts before text it pipes to a
 * program when `$OutputEncoding` is UTF-8 with a BOM, as on GitHub's Windows
 * runners. It is never part of an answer. */
const BYTE_ORDER_MARK = "\uFEFF";

/** `text` without a leading byte order mark. */
function withoutBom(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
}

/** Whether a stream is captured or dropped. */
type StreamMode = "pipe" | "ignore";

/**
 * How to run one command. `env`, when given, is the child's whole environment,
 * so callers that want to add a variable merge `process.env` themselves; an
 * absent `input` closes stdin, so no command waits for a prompt.
 */
export interface RunOptions {
  /** The child's working folder; the caller's when absent. */
  readonly cwd?: string;
  /** The child's whole environment, not an overlay on the caller's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Bytes written to stdin before it is closed. */
  readonly input?: string | Uint8Array;
  /** `stdout` is captured by default; `ignore` gives empty bytes. */
  readonly stdout?: StreamMode;
  /** `stderr` is captured by default; `ignore` gives empty bytes. */
  readonly stderr?: StreamMode;
  /** Kills the child with SIGKILL after this many milliseconds. */
  readonly timeoutMs?: number;
  /** Kills the child with SIGKILL when it fires; the run reports `timedOut`. */
  readonly signal?: AbortSignal;
  /**
   * Runs the child on this process's own terminal (`stdio: "inherit"`), so it
   * can prompt with `sudo`: our stdout is flushed first and nothing is
   * captured. `run` honours this option; `runSync` has no asynchronous flush to
   * wait on and leaves it alone.
   */
  readonly inherit?: true;
}

/**
 * What one run produced. `code` is the child's exit code, or the shell's
 * missing (127) / timeout (124) / cannot-start (126) number; an ignored stream
 * yields empty bytes. `missing` and `timedOut` say why a code was invented, so
 * a caller never has to guess from the number alone.
 */
export interface RunResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly missing?: true;
  readonly timedOut?: true;
  /** The child never started: a missing command, or any other spawn error. */
  readonly notStarted?: true;
}

function emptyBytes(): Uint8Array {
  return new Uint8Array(0);
}

function failedResult(): RunResult {
  return {
    code: SPAWN_FAILED_CODE,
    stdout: emptyBytes(),
    stderr: emptyBytes(),
    notStarted: true,
  };
}

function missingResult(): RunResult {
  return {
    code: MISSING_CODE,
    stdout: emptyBytes(),
    stderr: emptyBytes(),
    missing: true,
    notStarted: true,
  };
}

/** Join the chunks a stream delivered into one buffer. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/** Keep every chunk a captured stream delivers. A read error keeps what
 * arrived before it: the exit code still describes the run. */
function capture(
  stream: NodeJS.ReadableStream | null,
  chunks: Uint8Array[],
): void {
  if (stream === null) {
    return;
  }
  stream.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  stream.on("error", () => {
    // The pipe failed after some output; the child's exit code is still the
    // result, so there is nothing else to report.
  });
}

/** A child may exit without reading its stdin; the failed write (EPIPE) then
 * changes nothing about its exit code, so it is not reported. */
function skipInputWriteError(): void {
  // Nothing to do: the run's result comes from the exit code and the output.
}

/** The result of a child that reported a code or a signal. A timeout wins over
 * the SIGKILL it caused, so the caller sees 124 rather than 137. */
function closedResult(
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  stdoutChunks: readonly Uint8Array[],
  stderrChunks: readonly Uint8Array[],
): RunResult {
  const stdout = concat(stdoutChunks);
  const stderr = concat(stderrChunks);
  if (timedOut) {
    return { code: TIMEOUT_CODE, stdout, stderr, timedOut: true };
  }
  if (code !== null) {
    return { code, stdout, stderr };
  }
  if (signal !== null) {
    const number = osConstants.signals[signal] ?? 0;
    return { code: SIGNAL_EXIT_OFFSET + number, stdout, stderr };
  }
  return { code: SPAWN_FAILED_CODE, stdout, stderr };
}

/** The result of a spawn that never reached the child. */
function spawnErrorResult(error: Error | undefined): RunResult {
  return errorCode(error) === NOT_FOUND ? missingResult() : failedResult();
}

/** The `code` a Node error carries, when it has one. */
function errorCode(error: Error | undefined): string | undefined {
  if (error === undefined || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** A stream's value as bytes: an ignored stream (null) is empty, and a string
 * only appears when a caller asked `spawnSync` for text. */
function toBytes(value: Uint8Array | string | null): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return value ?? emptyBytes();
}

/**
 * Resolve once every byte written to our stdout so far has left the process,
 * so a child given the same terminal does not print before our own lines.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write("", () => {
      resolve();
    });
  });
}

/**
 * Run one command with an argument array and no shell. Never rejects: a
 * missing command is `missing: true` with code 127, any other start failure
 * is code 126, and a `timeoutMs` overrun kills the child and reports 124 with
 * the output read so far.
 */
export async function run(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const [file, ...args] = argv;
  if (file === undefined) {
    return failedResult();
  }
  const command = resolveCommand(file, options.env);
  if (command === null) {
    return missingResult();
  }
  if (options.inherit === true) {
    await flushStdout();
  }
  const stdinMode: StreamMode = options.input === undefined ? "ignore" : "pipe";
  const spawnOptions: SpawnOptions = {
    stdio:
      options.inherit === true
        ? "inherit"
        : [stdinMode, options.stdout ?? "pipe", options.stderr ?? "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
  };
  let child: ChildProcess;
  try {
    child = spawn(command, args, spawnOptions);
  } catch {
    // A command line the system refuses outright (a NUL in an argument) never
    // starts at all.
    return failedResult();
  }
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  capture(child.stdout, stdoutChunks);
  capture(child.stderr, stderrChunks);
  if (options.input !== undefined && child.stdin !== null) {
    child.stdin.on("error", skipInputWriteError);
    child.stdin.end(options.input);
  }
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: RunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", stop);
      resolve(result);
    };
    // A timeout or an abort settles at once with what was read so far: a
    // process the child started may hold the pipes open, so waiting for
    // "close" would bring back the hang the limit exists to stop.
    const stop = (): void => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(KILL_SIGNAL);
      }
      settle(closedResult(null, null, true, stdoutChunks, stderrChunks));
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(stop, options.timeoutMs);
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        stop();
      } else {
        options.signal.addEventListener("abort", stop, { once: true });
      }
    }
    child.on("error", (error: Error) => {
      settle(spawnErrorResult(error));
    });
    child.on("close", (code, signal) => {
      settle(closedResult(code, signal, timedOut, stdoutChunks, stderrChunks));
    });
  });
}

/**
 * The synchronous form of `run`, for callers that cannot await. Same codes and
 * streams; `spawnSync`'s own timeout disables SIGKILL's number (137) in favour
 * of 124, and its output limit is lifted so the async and sync forms return
 * the same bytes.
 */
export function runSync(
  argv: readonly string[],
  options: RunOptions = {},
): RunResult {
  const [file, ...args] = argv;
  if (file === undefined) {
    return failedResult();
  }
  const command = resolveCommand(file, options.env);
  if (command === null) {
    return missingResult();
  }
  const stdinMode: StreamMode = options.input === undefined ? "ignore" : "pipe";
  const spawnOptions: SpawnSyncOptions = {
    stdio: [stdinMode, options.stdout ?? "pipe", options.stderr ?? "pipe"],
    killSignal: KILL_SIGNAL,
    maxBuffer: Number.POSITIVE_INFINITY,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command, args, spawnOptions);
  } catch {
    // As in `run`: a command line the system refuses never starts.
    return failedResult();
  }
  const stdout = toBytes(result.stdout);
  const stderr = toBytes(result.stderr);
  const code = errorCode(result.error);
  if (code === NOT_FOUND) {
    return missingResult();
  }
  if (code === TIMED_OUT) {
    return { code: TIMEOUT_CODE, stdout, stderr, timedOut: true };
  }
  if (result.error !== undefined) {
    return { code: SPAWN_FAILED_CODE, stdout, stderr, notStarted: true };
  }
  if (result.status !== null) {
    return { code: result.status, stdout, stderr };
  }
  if (result.signal !== null) {
    const number = osConstants.signals[result.signal] ?? 0;
    return { code: SIGNAL_EXIT_OFFSET + number, stdout, stderr };
  }
  return { code: SPAWN_FAILED_CODE, stdout, stderr };
}

/** UTF-8 text from a run's bytes, so every caller compares the same way. */
export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The value of `key` in `env`. On Windows the name is case-insensitive, so
 * a plain object holding `Path` still answers a `PATH` lookup; an exact match
 * wins, as it does for the variable Windows itself reads. */
function envEntry(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  windows: boolean,
): string | undefined {
  if (!windows || key in env) {
    return env[key];
  }
  const found = Object.keys(env).find(
    (name) => name.toUpperCase() === key.toUpperCase(),
  );
  return found === undefined ? undefined : env[found];
}

/** Whether `name` points into the filesystem rather than naming a command. */
function hasPathSeparator(name: string): boolean {
  return name.includes("/") || (IS_WINDOWS && name.includes("\\"));
}

/** The part of `fs.Stats` that `isCommandEntry` reads. */
export interface EntryKind {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Whether a lookup candidate is a command, from its `statSync` result
 * (`followed`) and `lstatSync` result (`linked`), each `undefined` when it
 * threw. A file is; a folder never is. On Windows a link that `stat` can't
 * follow counts too: an app execution alias such as `WindowsApps\winget.exe`
 * is a 0-byte reparse point that `stat` fails on (Bun: `EACCES`) or reports as
 * a link, while Windows starts it like any program. Elsewhere a dangling
 * link is not found.
 */
export function isCommandEntry(
  followed: EntryKind | undefined,
  linked: EntryKind | undefined,
  windows: boolean,
): boolean {
  if (followed?.isFile() === true) {
    return true;
  }
  if (followed?.isDirectory() === true) {
    return false;
  }
  return windows && linked?.isSymbolicLink() === true;
}

function statOrUndefined(
  file: string,
  read: (path: string) => EntryKind,
): EntryKind | undefined {
  try {
    return read(file);
  } catch {
    // Missing or unreadable (an alias stat can't follow): no answer from this call.
    return undefined;
  }
}

function isFile(file: string): boolean {
  const followed = statOrUndefined(file, statSync);
  const needsLink =
    IS_WINDOWS &&
    followed?.isFile() !== true &&
    followed?.isDirectory() !== true;
  const linked = needsLink ? statOrUndefined(file, lstatSync) : undefined;
  return isCommandEntry(followed, linked, IS_WINDOWS);
}

function isExecutableFile(file: string): boolean {
  if (!isFile(file)) {
    return false;
  }
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    // No execute permission: the caller could not run it.
    return false;
  }
}

/**
 * Whether `spawn` can start `file` without a shell: anything on Linux and
 * macOS, only a `.com` or `.exe` on Windows (ignoring case).
 */
export function isSpawnable(
  file: string,
  windows: boolean = IS_WINDOWS,
): boolean {
  if (!windows) {
    return true;
  }
  const lower = file.toLowerCase();
  return WINDOWS_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** A Windows PATH folder may be written in double quotes (`"C:\Program
 * Files\Git\cmd"`), which Windows itself ignores; one pair is dropped. */
function unquoted(folder: string): string {
  return folder.length >= QUOTED_MIN_LENGTH &&
    folder.startsWith(PATH_QUOTE) &&
    folder.endsWith(PATH_QUOTE)
    ? folder.slice(1, -1)
    : folder;
}

/**
 * The PATH entries to search, split on the platform's delimiter. Empty and
 * relative entries are skipped, so the working folder is never searched
 * (contract "The program"). `windows` defaults to the running platform; tests
 * pass it to check the Windows rules on any OS.
 */
export function searchFolders(
  env: Readonly<Record<string, string | undefined>>,
  windows: boolean = IS_WINDOWS,
): readonly string[] {
  const value = envEntry(env, "PATH", windows);
  if (value === undefined) {
    return [];
  }
  const path = windows ? win32 : posix;
  return value
    .split(path.delimiter)
    .map((folder) => (windows ? unquoted(folder) : folder))
    .filter((folder) => path.isAbsolute(folder));
}

/**
 * The file `spawn` is given: a bare name resolved on `PATH` only, since
 * Windows would otherwise search the working folder first and run a `git.exe`
 * committed to the repo; a name holding a path separator as given. `null`
 * when a bare name isn't on `PATH`.
 */
function resolveCommand(
  file: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string | null {
  if (hasPathSeparator(file)) {
    return file;
  }
  return which(file, env ?? process.env);
}

/**
 * The full path of the first `name` on `PATH` that is an executable file, or
 * `null`. On Windows only a `.com` or `.exe` counts, the name as given or with
 * either suffix added, as `spawn` finds it; a `.cmd` or `.bat` is not found. A
 * name holding a path separator is taken as a path: returned as-is when it
 * exists and `spawn` can start it, otherwise `null`.
 */
export function which(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (hasPathSeparator(name)) {
    return isFile(name) && isSpawnable(name) ? name : null;
  }
  for (const folder of searchFolders(env)) {
    const candidate = join(folder, name);
    if (isSpawnable(candidate) && isExecutableFile(candidate)) {
      return candidate;
    }
    if (!IS_WINDOWS) {
      continue;
    }
    for (const suffix of WINDOWS_SUFFIXES) {
      const extended = `${candidate}${suffix}`;
      if (isExecutableFile(extended)) {
        return extended;
      }
    }
  }
  return null;
}

/**
 * The whole of stdin as UTF-8 text, for commands that take piped answers
 * (`import`'s prompts). Resolves at end of input.
 */
export function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    process.stdin.on("data", (chunk: Uint8Array) => {
      parts.push(decoder.decode(chunk, { stream: true }));
    });
    process.stdin.on("end", () => {
      parts.push(decoder.decode());
      resolve(withoutBom(parts.join("")));
    });
    process.stdin.on("error", (error: Error) => {
      reject(new Error("stdin could not be read", { cause: error }));
    });
  });
}

/**
 * Lines from `input`, each without its line ending, read lazily: a line is not
 * consumed until the previous one has been asked for, so a per-file prompt on
 * a terminal sees its question before the next answer arrives. The last line
 * without a newline is yielded at EOF, then the iterator ends. `\r\n` counts
 * as one line ending. A byte order mark before the first line is dropped.
 */
export async function* stdinLines(
  input: NodeJS.ReadableStream = process.stdin,
): AsyncIterableIterator<string> {
  const reader = createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    let first = true;
    for await (const line of reader) {
      yield first ? withoutBom(line) : line;
      first = false;
    }
  } finally {
    reader.close();
  }
}
