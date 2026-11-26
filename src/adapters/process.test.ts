import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  decode,
  isSpawnable,
  run,
  runSync,
  stdinLines,
  which,
} from "./process.ts";

/** One command that writes to both streams and fails, so a run shows all three. */
const PRINT_AND_FAIL = "printf out; printf err >&2; exit 3";

const EXIT_CODE_THREE = 3;

const EXIT_CODE_FOUR = 4;

const STDIN_TEXT = "a\nb\n";

const STDIN_BYTES = new TextEncoder().encode(STDIN_TEXT);

const MISSING_COMMAND = "no-such-cmd-xyz";

/** The byte order mark PowerShell may pipe before its text. */
const BOM = "\uFEFF";

const MISSING_CODE = 127;

const TIMEOUT_CODE = 124;

const TIMEOUT_MS = 100;

/** A run that respects its deadline must finish well inside this. */
const TIMEOUT_LIMIT_MS = 2_000;

const SLEEP_SECONDS = "5";

/** A command name no system has, written as a script by `fakeCommand`. */
const FAKE_COMMAND = "mk-fake-cmd";

const FAKE_OUTPUT = "fake ran";

/** A relative PATH entry, which the search must skip. */
const RELATIVE_FOLDER = ".";

const EXECUTABLE_MODE = 0o755;

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-process-"));
  tempFolders.push(folder);
  return folder;
}

/** A folder holding an executable `FAKE_COMMAND` that prints `FAKE_OUTPUT`. */
function fakeCommandFolder(): string {
  const folder = tempFolder();
  const file = join(folder, FAKE_COMMAND);
  writeFileSync(file, `#!/bin/sh\nprintf '${FAKE_OUTPUT}'\n`);
  chmodSync(file, EXECUTABLE_MODE);
  return folder;
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("run", () => {
  test("should report the exit code and both streams when the command writes and fails", async () => {
    // Act
    const result = await run(["sh", "-c", PRINT_AND_FAIL]);

    // Assert
    expect(result.code).toBe(EXIT_CODE_THREE);
    expect(decode(result.stdout)).toBe("out");
    expect(decode(result.stderr)).toBe("err");
    expect(result.missing).toBeUndefined();
    expect(result.timedOut).toBeUndefined();
  });

  test("should feed a string input to stdin when input is a string", async () => {
    // Act
    const result = await run(["cat"], { input: STDIN_TEXT });

    // Assert
    expect(result.code).toBe(0);
    expect(decode(result.stdout)).toBe(STDIN_TEXT);
  });

  test("should feed byte input to stdin when input is bytes", async () => {
    // Act
    const result = await run(["cat"], { input: STDIN_BYTES });

    // Assert
    expect(result.code).toBe(0);
    expect(decode(result.stdout)).toBe(STDIN_TEXT);
  });

  test("should report a missing command without throwing when it is not on PATH", async () => {
    // Act
    const result = await run([MISSING_COMMAND]);

    // Assert
    expect(result.missing).toBe(true);
    expect(result.code).toBe(MISSING_CODE);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
  });

  test("should kill the child and report a timeout when it runs past timeoutMs", async () => {
    // Arrange
    const startedAt = Date.now();

    // Act
    const result = await run(["sleep", SLEEP_SECONDS], {
      timeoutMs: TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(TIMEOUT_CODE);
    expect(elapsedMs).toBeLessThan(TIMEOUT_LIMIT_MS);
  });

  test("should settle on timeout when a grandchild holds the pipes", async () => {
    // Arrange
    const startedAt = Date.now();
    const holdPipes = `sleep ${SLEEP_SECONDS} & exit 0`;

    // Act
    const result = await run(["sh", "-c", holdPipes], {
      timeoutMs: TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(TIMEOUT_LIMIT_MS);
  });

  test("should kill the child and settle when the signal aborts", async () => {
    // Arrange
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Act
    const result = await run(["sleep", SLEEP_SECONDS], {
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(TIMEOUT_LIMIT_MS);
  });

  test("should mark a missing command as not started", async () => {
    // Act
    const result = await run(["no-such-cmd-xyz"]);

    // Assert
    expect(result.notStarted).toBe(true);
  });

  test("should give empty stdout when stdout is ignored", async () => {
    // Act
    const result = await run(["sh", "-c", PRINT_AND_FAIL], {
      stdout: "ignore",
    });

    // Assert
    expect(result.stdout.length).toBe(0);
    expect(decode(result.stderr)).toBe("err");
    expect(result.code).toBe(EXIT_CODE_THREE);
  });

  test("should run with the given env as the whole environment", async () => {
    // Act
    const result = await run(["sh", "-c", 'printf %s "$FOO"'], {
      env: { PATH: process.env.PATH, FOO: "bar" },
    });

    // Assert
    expect(result.code).toBe(0);
    expect(decode(result.stdout)).toBe("bar");
  });

  test("should report the exit code with no captured streams when inherit is set", async () => {
    // Act
    const result = await run(["sh", "-c", "exit 4"], { inherit: true });

    // Assert
    expect(result.code).toBe(EXIT_CODE_FOUR);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
  });

  test("should run in the given cwd when cwd is set", async () => {
    // Arrange
    const folder = tempFolder();

    // Act
    const result = await run(["pwd"], { cwd: folder });

    // Assert
    expect(realpathSync(decode(result.stdout).trim())).toBe(
      realpathSync(folder),
    );
  });
});

describe("runSync", () => {
  test("should report the exit code and both streams when the command writes and fails", () => {
    // Act
    const result = runSync(["sh", "-c", PRINT_AND_FAIL]);

    // Assert
    expect(result.code).toBe(EXIT_CODE_THREE);
    expect(decode(result.stdout)).toBe("out");
    expect(decode(result.stderr)).toBe("err");
  });

  test("should feed the input to stdin when input is given", () => {
    // Act
    const fromString = runSync(["cat"], { input: STDIN_TEXT });
    const fromBytes = runSync(["cat"], { input: STDIN_BYTES });

    // Assert
    expect(decode(fromString.stdout)).toBe(STDIN_TEXT);
    expect(decode(fromBytes.stdout)).toBe(STDIN_TEXT);
  });

  test("should report a missing command without throwing when it is not on PATH", () => {
    // Act
    const result = runSync([MISSING_COMMAND]);

    // Assert
    expect(result.missing).toBe(true);
    expect(result.code).toBe(MISSING_CODE);
    expect(result.stdout.length).toBe(0);
  });
});

describe("which", () => {
  test("should return an absolute path when the command is on PATH", () => {
    // Act
    const found = which("sh");

    // Assert
    expect(found).not.toBeNull();
    expect(isAbsolute(found ?? "")).toBe(true);
  });

  test("should return null when no command matches", () => {
    // Act
    const found = which(MISSING_COMMAND);

    // Assert
    expect(found).toBeNull();
  });
});

describe("PATH only", () => {
  test("should not run a command from the working folder when run is given a bare name", async () => {
    // Arrange
    const folder = fakeCommandFolder();

    // Act
    const result = await run([FAKE_COMMAND], { cwd: folder });

    // Assert
    expect(result.code).toBe(MISSING_CODE);
    expect(result.missing).toBe(true);
  });

  test("should not run a command from the working folder when runSync is given a bare name", () => {
    // Arrange
    const folder = fakeCommandFolder();

    // Act
    const result = runSync([FAKE_COMMAND], { cwd: folder });

    // Assert
    expect(result.code).toBe(MISSING_CODE);
    expect(result.missing).toBe(true);
  });

  test("should skip a relative PATH folder when it names the working folder", async () => {
    // Arrange
    const folder = fakeCommandFolder();

    // Act
    const result = await run([FAKE_COMMAND], {
      cwd: folder,
      env: { PATH: RELATIVE_FOLDER },
    });

    // Assert
    expect(result.code).toBe(MISSING_CODE);
  });

  test("should run the command when an absolute PATH folder holds it", async () => {
    // Arrange
    const folder = fakeCommandFolder();

    // Act
    const result = await run([FAKE_COMMAND], { env: { PATH: folder } });

    // Assert
    expect(result.code).toBe(0);
    expect(decode(result.stdout)).toBe(FAKE_OUTPUT);
  });

  test("should return only the absolute folder's match when PATH also holds a relative one", () => {
    // Arrange
    const folder = fakeCommandFolder();
    const path = [RELATIVE_FOLDER, folder].join(delimiter);

    // Act
    const found = which(FAKE_COMMAND, { PATH: path });

    // Assert
    expect(found).toBe(join(folder, FAKE_COMMAND));
  });

  test("should run a name holding a path separator as given when it is not on PATH", async () => {
    // Arrange
    const folder = fakeCommandFolder();

    // Act
    const result = await run([join(folder, FAKE_COMMAND)], {
      env: { PATH: "" },
    });

    // Assert
    expect(result.code).toBe(0);
    expect(decode(result.stdout)).toBe(FAKE_OUTPUT);
  });
});

describe("isSpawnable", () => {
  test.each([
    ["C:\\bin\\gh.exe", true],
    ["C:\\bin\\GH.EXE", true],
    ["C:\\bin\\tool.com", true],
    ["C:\\bin\\gh.cmd", false],
    ["C:\\bin\\gh.BAT", false],
    ["C:\\bin\\gh", false],
  ])("should answer %s as %p on Windows", (file, expected) => {
    // Act
    const spawnable = isSpawnable(file, true);

    // Assert
    expect(spawnable).toBe(expected);
  });

  test("should accept any file when not on Windows", () => {
    // Act
    const spawnable = isSpawnable("/usr/local/bin/gh.cmd", false);

    // Assert
    expect(spawnable).toBe(true);
  });
});

describe("stdinLines", () => {
  test("should yield every line without its line ending when the input has CRLF and a final unterminated line", async () => {
    // Arrange
    const stream = new PassThrough();
    stream.end("x\r\ny\nz");

    // Act
    const lines: string[] = [];
    for await (const line of stdinLines(stream)) {
      lines.push(line);
    }

    // Assert
    expect(lines).toEqual(["x", "y", "z"]);
  });

  test("should drop a byte order mark before the first line only when PowerShell pipes one", async () => {
    // Arrange
    const stream = new PassThrough();
    stream.end(`${BOM}\r\n${BOM}y\n`);

    // Act
    const lines: string[] = [];
    for await (const line of stdinLines(stream)) {
      lines.push(line);
    }

    // Assert
    expect(lines).toEqual(["", `${BOM}y`]);
  });

  test("should wait for the next line when the previous one has been yielded and no more has arrived", async () => {
    // Arrange
    const stream = new PassThrough();
    const lines = stdinLines(stream);
    stream.write("first\n");

    // Act
    const first = await lines.next();
    let secondSettled = false;
    const second = lines.next().then((result) => {
      secondSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    stream.write("second\n");
    stream.end();

    // Assert
    expect(first).toEqual({ value: "first", done: false });
    expect(secondSettled).toBe(false);
    expect(await second).toEqual({ value: "second", done: false });
    expect(await lines.next()).toEqual({ value: undefined, done: true });
  });
});
