import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dconfDump, dconfLoad, loginHome } from "./dconf.ts";

const DCONF_PATH = "/org/gnome/shell/";

const DUMP_TEXT =
  "[org/gnome/desktop/interface]\nfont-name=Cantarell 11\n";

const USER = "tester";

const PASSWD_LINE = "tester:x:1000:1000:tester:/home/tester:/bin/sh";

const LOGIN_HOME = "/home/tester";

/** `sh` and `cat` live here; the stub folder is the only other PATH entry. */
const SYSTEM_PATH = "/usr/bin:/bin";

/** A dconf stub that prints the dump text. */
const DUMP_SCRIPT =
  "printf '%s\\n' '[org/gnome/desktop/interface]' 'font-name=Cantarell 11'";

/** A dconf stub that fails like a dump without a session bus. */
const DUMP_FAILURE_SCRIPT = "printf 'boom\\n' >&2\nexit 2";

/** A dconf stub that fails like a load without a session bus. */
const LOAD_FAILURE_SCRIPT = "cat > /dev/null\nexit 3";

/** A getent stub that exits non-zero, as for an unknown user. */
const GETENT_FAILURE_SCRIPT = "printf 'boom\\n' >&2\nexit 2";

/** A getent stub that prints a line with too few fields. */
const GETENT_MALFORMED_SCRIPT = "printf '%s\\n' 'tester:x:1000:1000:tester'";

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-dconf-"));
  tempFolders.push(folder);
  return folder;
}

/** Write an executable `#!/bin/sh` stub named `name` into `bin`. */
function writeStub(bin: string, name: string, script: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

/** The environment a test passes: its stub folder first, then the shell's. */
function stubEnv(bin: string): Record<string, string> {
  return { PATH: `${bin}:${SYSTEM_PATH}`, HOME: tempFolder() };
}

/** An environment whose PATH finds neither dconf nor getent. */
function emptyEnv(): Record<string, string> {
  return { PATH: tempFolder(), HOME: tempFolder() };
}

afterEach(() => {
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("dconfDump", () => {
  test("should return the dump text exactly", async () => {
    // Arrange
    const bin = tempFolder();
    writeStub(bin, "dconf", DUMP_SCRIPT);

    // Act
    const result = await dconfDump(DCONF_PATH, stubEnv(bin));

    // Assert
    expect(result).toEqual({ kind: "ok", text: DUMP_TEXT });
  });

  test("should report a non-zero exit as failed", async () => {
    // Arrange
    const bin = tempFolder();
    writeStub(bin, "dconf", DUMP_FAILURE_SCRIPT);

    // Act
    const result = await dconfDump(DCONF_PATH, stubEnv(bin));

    // Assert
    expect(result).toEqual({ kind: "failed" });
  });

  test("should report no dconf on PATH as missing", async () => {
    // Act
    const result = await dconfDump(DCONF_PATH, emptyEnv());

    // Assert
    expect(result).toEqual({ kind: "missing" });
  });
});

describe("dconfLoad", () => {
  test("should pass the path and the text on stdin", async () => {
    // Arrange
    const bin = tempFolder();
    const argsFile = join(tempFolder(), "args");
    const stdinFile = join(tempFolder(), "stdin");
    writeStub(
      bin,
      "dconf",
      `cat > '${stdinFile}'\nprintf '%s\\n' "$*" > '${argsFile}'`,
    );

    // Act
    const result = dconfLoad(DCONF_PATH, DUMP_TEXT, stubEnv(bin));

    // Assert
    expect(result).toEqual({ kind: "ok" });
    expect(readFileSync(stdinFile, "utf8")).toBe(DUMP_TEXT);
    expect(readFileSync(argsFile, "utf8").trim()).toBe(
      `load ${DCONF_PATH}`,
    );
  });

  test("should report a non-zero exit as failed", async () => {
    // Arrange
    const bin = tempFolder();
    writeStub(bin, "dconf", LOAD_FAILURE_SCRIPT);

    // Act
    const result = dconfLoad(DCONF_PATH, DUMP_TEXT, stubEnv(bin));

    // Assert
    expect(result).toEqual({ kind: "failed" });
  });
});

describe("loginHome", () => {
  test("should return the home field of the getent passwd line", async () => {
    // Arrange
    const bin = tempFolder();
    writeStub(bin, "getent", `printf '%s\\n' '${PASSWD_LINE}'`);

    // Act
    const home = await loginHome(USER, stubEnv(bin));

    // Assert
    expect(home).toBe(LOGIN_HOME);
  });

  test("should return undefined when getent exits non-zero", async () => {
    // Arrange
    const bin = tempFolder();
    writeStub(bin, "getent", GETENT_FAILURE_SCRIPT);

    // Act
    const home = await loginHome(USER, stubEnv(bin));

    // Assert
    expect(home).toBeUndefined();
  });

  test("should return undefined for a malformed passwd line", async () => {
    // Arrange
    const bin = tempFolder();
    writeStub(bin, "getent", GETENT_MALFORMED_SCRIPT);

    // Act
    const home = await loginHome(USER, stubEnv(bin));

    // Assert
    expect(home).toBeUndefined();
  });
});
