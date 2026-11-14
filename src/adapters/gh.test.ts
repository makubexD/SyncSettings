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
import { prCreate } from "./gh.ts";

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
