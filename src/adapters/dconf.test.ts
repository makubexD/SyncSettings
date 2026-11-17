import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dconfDump, dconfLoad, loginHome } from "./dconf.ts";

const DCONF_PATH = "/org/gnome/shell/";

/** Not a dconf folder: an option dconf would read as one. */
const OPTION_PATH = "--version";

const DUMP_TEXT = "[org/gnome/desktop/interface]\nfont-name=Cantarell 11\n";

/** The private bus's folder for these two runtime tests, not the caller's. */
const BUS_APP_PATH = "/test/app/";

const BUS_ROUNDTRIP_PATH = "/test/roundtrip/";

const BUS_SEEDED_DUMP = "[/]\na=1\n";

/** `a=2` is a valid value, but the file as a whole is not. */
const BUS_BAD_LOAD = "[/]\na=2\nbad=notvalid value\n";

/** Every gvariant shape a dump can print, in the order dconf writes them. */
const BUS_ROUNDTRIP_DUMP =
  "[/]\ne=@as []\nl=['a', 'b']\nm=\"it's\\nline2\"\ns='x=y'\nt=(1, 'x')\nu=uint32 3\n";

/** The private bus is optional locally; the tests skip without its tools. */
const BUS_SKIP_MESSAGE = "needs dbus-daemon and dconf on PATH";

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

/** A dconf stub that records that it ran in the file `marker`. */
function ranScript(marker: string): string {
  return `printf ran > '${marker}'`;
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

  test("should refuse a path that is not a dconf folder without running dconf", async () => {
    // Arrange
    const bin = tempFolder();
    const marker = join(bin, "dconf-ran");
    writeStub(bin, "dconf", ranScript(marker));

    // Act
    const result = await dconfDump(OPTION_PATH, stubEnv(bin));

    // Assert
    expect(result).toEqual({ kind: "failed" });
    expect(existsSync(marker)).toBe(false);
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
    expect(readFileSync(argsFile, "utf8").trim()).toBe(`load ${DCONF_PATH}`);
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

  test("should refuse a path that is not a dconf folder without running dconf", () => {
    // Arrange
    const bin = tempFolder();
    const marker = join(bin, "dconf-ran");
    writeStub(bin, "dconf", ranScript(marker));

    // Act
    const result = dconfLoad(OPTION_PATH, DUMP_TEXT, stubEnv(bin));

    // Assert
    expect(result).toEqual({ kind: "failed" });
    expect(existsSync(marker)).toBe(false);
  });
});

/** One `dbus-daemon` this file started and must stop. */
interface PrivateBus {
  readonly address: string;
  readonly pid: number;
  readonly home: string;
}

/** The `code` of a Node error, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code: unknown = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** A session bus that is not the caller's, with its own home and config. */
function startPrivateBus(): PrivateBus {
  const home = mkdtempSync(join(tmpdir(), "mksync-dconf-bus-"));
  mkdirSync(join(home, ".config"), { recursive: true });
  const result = Bun.spawnSync({
    cmd: [
      "dbus-daemon",
      "--session",
      "--fork",
      "--print-address=1",
      "--print-pid=1",
    ],
    env: {
      PATH: process.env.PATH ?? SYSTEM_PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [address, pidText] = result.stdout.toString().split("\n");
  const pid = Number.parseInt(pidText ?? "", 10);
  if (
    result.exitCode !== 0 ||
    address === undefined ||
    address === "" ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(
      `dbus-daemon did not start: ${result.stderr.toString()}${result.stdout.toString()}`,
    );
  }
  return { address, pid, home };
}

function stopPrivateBus(bus: PrivateBus): void {
  try {
    process.kill(bus.pid, "SIGTERM");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      throw error;
    }
  } finally {
    rmSync(bus.home, { recursive: true, force: true });
  }
}

/** The environment every dconf call of these tests runs with. */
function privateBusEnv(bus: PrivateBus): Record<string, string> {
  return {
    PATH: process.env.PATH ?? SYSTEM_PATH,
    HOME: bus.home,
    XDG_CONFIG_HOME: join(bus.home, ".config"),
    DBUS_SESSION_BUS_ADDRESS: bus.address,
  };
}

const BUS_TOOLS_PRESENT =
  Bun.which("dbus-daemon") !== null && Bun.which("dconf") !== null;

if (!BUS_TOOLS_PRESENT) {
  test.skip(`private bus tests: ${BUS_SKIP_MESSAGE}`, () => {});
}

describe.skipIf(!BUS_TOOLS_PRESENT)("dconf on a private session bus", () => {
  let bus: PrivateBus | undefined;

  function env(): Record<string, string> {
    if (bus === undefined) {
      throw new Error(`the private bus did not start; ${BUS_SKIP_MESSAGE}`);
    }
    return privateBusEnv(bus);
  }

  beforeAll(() => {
    const started = startPrivateBus();
    // Asserted before any dconf call: the tests never reach the caller's bus.
    expect(started.address).not.toBe(process.env.DBUS_SESSION_BUS_ADDRESS);
    expect(started.address).not.toBe("");
    bus = started;
  });

  afterAll(() => {
    const started = bus;
    bus = undefined;
    if (started !== undefined) {
      stopPrivateBus(started);
    }
  });

  test("should leave the key unchanged when the load text is invalid", async () => {
    // Arrange
    const loaded = dconfLoad(BUS_APP_PATH, BUS_SEEDED_DUMP, env());
    expect(loaded).toEqual({ kind: "ok" });

    // Act
    const result = dconfLoad(BUS_APP_PATH, BUS_BAD_LOAD, env());

    // Assert
    expect(result).toEqual({ kind: "failed" });
    expect(await dconfDump(BUS_APP_PATH, env())).toEqual({
      kind: "ok",
      text: BUS_SEEDED_DUMP,
    });
  });

  test("should dump the values it loaded byte for byte", async () => {
    // Arrange
    const loaded = dconfLoad(BUS_ROUNDTRIP_PATH, BUS_ROUNDTRIP_DUMP, env());
    expect(loaded).toEqual({ kind: "ok" });

    // Act
    const result = await dconfDump(BUS_ROUNDTRIP_PATH, env());

    // Assert
    expect(result).toEqual({ kind: "ok", text: BUS_ROUNDTRIP_DUMP });
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
