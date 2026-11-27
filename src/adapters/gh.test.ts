import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerToken, prCreate, resetOwnerTokenCache, runGh } from "./gh.ts";

const BASE = "master";

const HEAD = "sync/linux-laptop-20260101-0000";

const TITLE = "sync: add a";

const BODY = "body text";

const BODY_FILE = "pr-body.txt";

const PR_URL = "https://github.com/example/repo/pull/7";

/** A gh stub that prints the PR URL and exits 0. */
const SUCCESS_SCRIPT = `printf '%s\\n' '${PR_URL}'`;

/** A gh stub that fails with a message on stderr. */
const FAILURE_SCRIPT = "printf 'boom\\n' >&2\nexit 1";

/** A gh stub that never returns, so the limit has to kill it. */
const HANG_SCRIPT = "exec sleep 5";

const originalGh = process.env.GH;

const tempFolders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "mksync-gh-"));
  tempFolders.push(folder);
  return folder;
}

/**
 * A stub `gh` in `bin`: it logs `<cwd>|<args>` and then runs `script`.
 *
 * The stub is named through `GH`, which `commit.sh` reads (`GH=${GH:-gh}`),
 * rather than placed on PATH: Bun.spawn resolves the command against the PATH
 * the process started with, so a PATH the test changes is not seen.
 */
function writeStub(bin: string, log: string, script: string): string {
  const path = join(bin, "gh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$PWD" "$*" >> '${log}'\n${script}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

interface Stub {
  readonly root: string;
  readonly log: string;
}

/** Name a stub `gh` through `GH` and return the repo root it runs in. */
function installStub(script: string): Stub {
  const root = tempFolder();
  const log = join(tempFolder(), "gh.log");
  process.env.GH = writeStub(tempFolder(), log, script);
  return { root, log };
}

beforeEach(() => {
  resetOwnerTokenCache();
});

afterEach(() => {
  if (originalGh === undefined) {
    delete process.env.GH;
  } else {
    process.env.GH = originalGh;
  }
  while (tempFolders.length > 0) {
    const folder = tempFolders.pop();
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

describe("prCreate", () => {
  test("should run gh pr create with a body file in the repo root", async () => {
    // Arrange
    const { root, log } = installStub(SUCCESS_SCRIPT);
    const expected = `${root}|pr create --base ${BASE} --head ${HEAD} --title ${TITLE} --body-file ${BODY_FILE}`;

    // Act
    const result = await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      bodyFile: BODY_FILE,
    });

    // Assert
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(PR_URL);
    expect(readFileSync(log, "utf8").trim()).toBe(expected);
  });

  test("should pass the body inline when no body file is given", async () => {
    // Arrange
    const { root, log } = installStub(SUCCESS_SCRIPT);
    const expected = `${root}|pr create --base ${BASE} --head ${HEAD} --title ${TITLE} --body ${BODY}`;

    // Act
    await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      body: BODY,
    });

    // Assert
    expect(readFileSync(log, "utf8").trim()).toBe(expected);
  });

  test("should report a failing gh as a result", async () => {
    // Arrange
    const { root } = installStub(FAILURE_SCRIPT);

    // Act
    const result = await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      bodyFile: BODY_FILE,
    });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  test("should report a missing gh as a failure", async () => {
    // Arrange
    const root = tempFolder();
    process.env.GH = join(tempFolder(), "missing-gh");

    // Act
    const result = await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      bodyFile: BODY_FILE,
    });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.code).toBe(-1);
  });

  test("should give up when gh outlasts the limit", async () => {
    // Arrange
    const { root } = installStub(HANG_SCRIPT);

    // Act
    const result = await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      bodyFile: BODY_FILE,
      timeoutMs: 50,
    });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.code).toBe(-1);
  });

  test("should run the binary GH names", async () => {
    // Arrange
    const root = tempFolder();
    const log = join(tempFolder(), "gh.log");
    process.env.GH = writeStub(tempFolder(), log, SUCCESS_SCRIPT);

    // Act
    const result = await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      bodyFile: BODY_FILE,
    });

    // Assert
    expect(result.ok).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("pr create");
  });
});

const OWNER = "owner1";

const TOKEN = "tok-owner1";

/** A stub that logs the token it sees and prints a token for `auth token`. */
const TOKEN_SCRIPT = `printf 'env=%s\\n' "$GH_TOKEN" >> "$(dirname "$0")/env.log"\nprintf '${TOKEN}\\n'`;

describe("ownerToken", () => {
  test.each(["", "-x/../y", "a b", "own;er", "a".repeat(40), "ow\nner"])(
    "should not run gh when the owner name is %p",
    async (name) => {
      // Arrange
      const { log } = installStub(TOKEN_SCRIPT);

      // Act
      const token = await ownerToken(name);

      // Assert
      expect(token).toBeUndefined();
      expect(existsSync(log)).toBe(false);
    },
  );

  test("should not run gh when there is no owner", async () => {
    // Arrange
    const { log } = installStub(TOKEN_SCRIPT);

    // Act
    const token = await ownerToken(undefined);

    // Assert
    expect(token).toBeUndefined();
    expect(existsSync(log)).toBe(false);
  });

  test("should return the trimmed token gh prints for the owner", async () => {
    // Arrange
    const { log } = installStub(TOKEN_SCRIPT);

    // Act
    const token = await ownerToken(OWNER);

    // Assert
    expect(token).toBe(TOKEN);
    expect(readFileSync(log, "utf8")).toContain(`|auth token --user ${OWNER}`);
  });

  test("should be undefined when gh fails", async () => {
    // Arrange
    installStub(FAILURE_SCRIPT);

    // Act
    const token = await ownerToken(OWNER);

    // Assert
    expect(token).toBeUndefined();
  });

  test("should be undefined when gh prints only whitespace", async () => {
    // Arrange
    installStub("printf '  \\n'");

    // Act
    const token = await ownerToken(OWNER);

    // Assert
    expect(token).toBeUndefined();
  });

  test("should be undefined when gh is missing", async () => {
    // Arrange
    installStub(SUCCESS_SCRIPT);
    process.env.GH = join(tempFolder(), "no-such-gh");

    // Act
    const token = await ownerToken(OWNER);

    // Assert
    expect(token).toBeUndefined();
  });

  test("should ask gh once per owner", async () => {
    // Arrange
    const { log } = installStub(TOKEN_SCRIPT);

    // Act
    const results = await Promise.all([
      ownerToken(OWNER),
      ownerToken(OWNER),
      ownerToken(OWNER),
    ]);
    await ownerToken(OWNER);

    // Assert
    expect(results).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("runGh token", () => {
  test("should put GH_TOKEN in the child's environment only when given", async () => {
    // Arrange
    const { root } = installStub('printf "[%s]" "$GH_TOKEN"');
    const before = process.env.GH_TOKEN;

    // Act
    const without = await runGh(root, ["x"], 5_000);
    const withToken = await runGh(root, ["x"], 5_000, TOKEN);

    // Assert
    expect(without.stdout).toBe("[]");
    expect(withToken.stdout).toBe(`[${TOKEN}]`);
    expect(process.env.GH_TOKEN).toBe(before);
  });

  test("should not return the token in a failure the caller prints", async () => {
    // Arrange
    const { root } = installStub("exit 1");

    // Act
    const result = await prCreate(root, {
      base: BASE,
      head: HEAD,
      title: TITLE,
      token: TOKEN,
    });

    // Assert
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
