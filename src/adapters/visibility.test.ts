import { describe, expect, test } from "bun:test";
import { readVisibility } from "./visibility.ts";
import type {
  ApiReply,
  CommandOutput,
  Visibility,
  VisibilityDeps,
} from "./visibility.ts";

const OWNER = "octocat";

const REPO = "hello-world";

const SLUG = `${OWNER}/${REPO}`;

const GITHUB_HTTPS = `https://github.com/${SLUG}`;

const API_URL = `https://api.github.com/repos/${SLUG}`;

const GH_SLUG = `github.com/${SLUG}`;

const GH_ARGS = ["gh", "repo", "view", GH_SLUG, "--json", "visibility"];

const GITHUB_ORIGINS: readonly string[] = [
  GITHUB_HTTPS,
  `${GITHUB_HTTPS}.git`,
  `git@github.com:${SLUG}`,
  `git@github.com:${SLUG}.git`,
  `ssh://git@github.com/${SLUG}`,
  `ssh://git@github.com/${SLUG}.git`,
];

/** github.com origins the parser doesn't read: they must fail closed. */
const UNPARSED_GITHUB_ORIGINS: readonly string[] = [
  `${GITHUB_HTTPS}/`,
  `https://user@github.com/${SLUG}.git`,
  `https://GitHub.com/${SLUG}`,
  `https://www.github.com/${SLUG}`,
  "https://github.com/-o/r",
];

/** Origins that name no repo on `github.com`, including look-alikes. */
const OTHER_ORIGINS: readonly string[] = [
  "/tmp/fixtures/bare.git",
  "https://gitlab.com/someone/repo",
  `https://github.com.evil.example/${SLUG}`,
];

/** A gh answer: exit 0 with `{"visibility": <visibility>}`. */
function ghAnswer(visibility: string): CommandOutput {
  return { code: 0, stdout: JSON.stringify({ visibility }) };
}

function commandOutput(code: number, stdout: string): CommandOutput {
  return { code, stdout };
}

function apiReply(status: number, body: unknown): ApiReply {
  return { status, json: async () => body };
}

/**
 * Deps whose calls fail the test unless the test replaces them: no case may
 * reach a real `gh` or the network.
 */
function deps(
  options: {
    readonly run?: VisibilityDeps["run"];
    readonly fetch?: VisibilityDeps["fetch"];
    readonly timeoutMs?: number;
  } = {},
): VisibilityDeps {
  return {
    run: options.run ?? (() => Promise.reject(new Error("gh must not run"))),
    fetch:
      options.fetch ??
      (() => Promise.reject(new Error("the API must not be called"))),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

/** The `owner/repo` a `github.com` SSH alias is resolved to. */
const ALIAS_SLUG = "o/r";

const ALIAS_ORIGIN = "git@gh-alias:o/r.git";

const ALIAS_SSH_URL = "ssh://git@gh-alias:2222/o/r.git";

const ALIAS_GH_ARGS = [
  "gh",
  "repo",
  "view",
  `github.com/${ALIAS_SLUG}`,
  "--json",
  "visibility",
];

/** An `ssh -G` answer: config lines ending in the lowered hostname. */
function sshHostname(hostname: string): CommandOutput {
  return commandOutput(0, `user git\nhostname ${hostname}\n`);
}

/**
 * A run stub that records every call and answers `ssh -G` and `gh`; a command
 * without an answer fails, so no case reaches a real binary.
 */
function runStub(answers: {
  readonly ssh?: (host: string) => CommandOutput;
  readonly gh?: () => CommandOutput;
}): { readonly calls: string[][]; readonly run: VisibilityDeps["run"] } {
  const calls: string[][] = [];
  const run: VisibilityDeps["run"] = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "ssh") {
      return answers.ssh?.(args[1] ?? "") ?? commandOutput(1, "");
    }
    return answers.gh?.() ?? commandOutput(1, "");
  };
  return { calls, run };
}

/** A time limit short enough that the timeout case runs in a few milliseconds. */
const FAST_TIMEOUT_MS = 10;

/** The gh answers that must send the reader on to the GitHub API. */
const GH_FAILURES: ReadonlyArray<readonly [string, VisibilityDeps["run"]]> = [
  ["gh is missing", () => Promise.reject(new Error("gh is not installed"))],
  ["gh fails", async () => commandOutput(1, "")],
  [
    "gh is not signed in",
    async () =>
      commandOutput(
        4,
        "To get started with GitHub CLI, please run: gh auth login\n",
      ),
  ],
  ["gh prints bad JSON", async () => commandOutput(0, "not json")],
  ["gh prints an unknown visibility", async () => ghAnswer("OTHER")],
];

/** Every GitHub API answer, and the visibility it must produce. */
const API_ANSWERS: ReadonlyArray<
  readonly [string, VisibilityDeps["fetch"], Visibility]
> = [
  ["a private repo", async () => apiReply(200, { private: true }), "private"],
  ["a public repo", async () => apiReply(200, { private: false }), "public"],
  ["a missing repo", async () => apiReply(404, {}), "public"],
  ["a server error", async () => apiReply(500, {}), "public"],
  [
    "a non-boolean private",
    async () => apiReply(200, { private: "yes" }),
    "public",
  ],
  [
    "bad JSON",
    async () => ({
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad JSON")),
    }),
    "public",
  ],
  [
    "a network error",
    () => Promise.reject(new TypeError("no network")),
    "public",
  ],
  [
    "a timeout",
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    "public",
  ],
];

describe("readVisibility", () => {
  test.each(GITHUB_ORIGINS)("should ask gh about %s", async (origin) => {
    // Arrange
    const calls: string[][] = [];
    const fakes = deps({
      run: async (command, args) => {
        calls.push([command, ...args]);
        return ghAnswer("PUBLIC");
      },
    });

    // Act
    const visibility = await readVisibility(
      origin,
      { MKSYNC_VISIBILITY: "private" },
      fakes,
    );

    // Assert
    expect(visibility).toBe("public");
    expect(calls).toEqual([GH_ARGS]);
  });

  test.each([
    ["PRIVATE", "private"],
    ["INTERNAL", "private"],
    ["PUBLIC", "public"],
  ] as const)(
    "should read gh visibility %s as %s",
    async (answer, expected) => {
      // Arrange
      const fakes = deps({ run: async () => ghAnswer(answer) });

      // Act
      const visibility = await readVisibility(GITHUB_HTTPS, {}, fakes);

      // Assert
      expect(visibility).toBe(expected);
    },
  );

  test("should ignore MKSYNC_VISIBILITY for github.com", async () => {
    // Arrange
    const fakes = deps({ run: async () => ghAnswer("PUBLIC") });

    // Act
    const visibility = await readVisibility(
      GITHUB_HTTPS,
      { MKSYNC_VISIBILITY: "private" },
      fakes,
    );

    // Assert
    expect(visibility).toBe("public");
  });

  test.each(GH_FAILURES)(
    "should fall to the API when %s",
    async (_case, run) => {
      // Arrange
      const urls: string[] = [];
      const fakes = deps({
        run,
        fetch: async (url) => {
          urls.push(url);
          return apiReply(200, { private: true });
        },
      });

      // Act
      const visibility = await readVisibility(GITHUB_HTTPS, {}, fakes);

      // Assert
      expect(visibility).toBe("private");
      expect(urls).toEqual([API_URL]);
    },
  );

  test("should fall to the API when gh runs past its time limit", async () => {
    // Arrange
    const calls: string[][] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const hangingRun: VisibilityDeps["run"] = async (
      command,
      args,
      signal,
    ) => {
      calls.push([command, ...args]);
      signals.push(signal);
      return await new Promise<CommandOutput>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("gh must be given a signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("gh was aborted"));
          },
          { once: true },
        );
      });
    };
    const urls: string[] = [];
    const fakes = deps({
      run: hangingRun,
      timeoutMs: FAST_TIMEOUT_MS,
      fetch: async (url) => {
        urls.push(url);
        return apiReply(200, { private: true });
      },
    });

    // Act
    const visibility = await readVisibility(GITHUB_HTTPS, {}, fakes);

    // Assert
    expect(visibility).toBe("private");
    expect(calls).toEqual([GH_ARGS]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(urls).toEqual([API_URL]);
  });

  test.each(API_ANSWERS)(
    "should read %s from the API as %s",
    async (_case, fetchReply, expected) => {
      // Arrange
      const urls: string[] = [];
      const fakes = deps({
        run: async () => commandOutput(1, ""),
        fetch: async (url, signal) => {
          urls.push(url);
          return await fetchReply(url, signal);
        },
      });

      // Act
      const visibility = await readVisibility(GITHUB_HTTPS, {}, fakes);

      // Assert
      expect(visibility).toBe(expected);
      expect(urls).toEqual([API_URL]);
    },
  );

  test.each(OTHER_ORIGINS)(
    "should default to public for %s without the variable",
    async (origin) => {
      // Act
      const visibility = await readVisibility(origin, {}, deps());

      // Assert
      expect(visibility).toBe("public");
    },
  );

  test.each(OTHER_ORIGINS)(
    "should read the variable as private for %s",
    async (origin) => {
      // Act
      const visibility = await readVisibility(
        origin,
        { MKSYNC_VISIBILITY: "private" },
        deps(),
      );

      // Assert
      expect(visibility).toBe("private");
    },
  );

  test("should default to public when the variable says something else", async () => {
    // Act
    const visibility = await readVisibility(
      "/tmp/fixtures/bare.git",
      { MKSYNC_VISIBILITY: "public" },
      deps(),
    );

    // Assert
    expect(visibility).toBe("public");
  });

  test.each(UNPARSED_GITHUB_ORIGINS)(
    "should read %s as public whatever the variable says",
    async (origin) => {
      // Act
      const visibility = await readVisibility(
        origin,
        { MKSYNC_VISIBILITY: "private" },
        deps(),
      );

      // Assert
      expect(visibility).toBe("public");
    },
  );

  test("should read no origin as public", async () => {
    // Act
    const visibility = await readVisibility(undefined, {}, deps());

    // Assert
    expect(visibility).toBe("public");
  });

  test("should read a private variable with no origin as private", async () => {
    // Act
    const visibility = await readVisibility(
      undefined,
      { MKSYNC_VISIBILITY: "private" },
      deps(),
    );

    // Assert
    expect(visibility).toBe("private");
  });

  describe("SSH host aliases", () => {
    test("should ask gh about the github.com an SSH alias resolves to", async () => {
      // Arrange
      const stub = runStub({
        ssh: () => sshHostname("github.com"),
        gh: () => ghAnswer("PRIVATE"),
      });

      // Act
      const visibility = await readVisibility(
        ALIAS_ORIGIN,
        {},
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("private");
      expect(stub.calls).toEqual([["ssh", "-G", "gh-alias"], ALIAS_GH_ARGS]);
    });

    test("should ignore MKSYNC_VISIBILITY for an SSH alias of github.com", async () => {
      // Arrange
      const stub = runStub({
        ssh: () => sshHostname("github.com"),
        gh: () => ghAnswer("PUBLIC"),
      });

      // Act
      const visibility = await readVisibility(
        ALIAS_ORIGIN,
        { MKSYNC_VISIBILITY: "private" },
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("public");
      expect(stub.calls).toEqual([["ssh", "-G", "gh-alias"], ALIAS_GH_ARGS]);
    });

    test("should resolve the host of an ssh:// alias before asking gh", async () => {
      // Arrange
      const stub = runStub({
        ssh: () => sshHostname("github.com"),
        gh: () => ghAnswer("PRIVATE"),
      });

      // Act
      const visibility = await readVisibility(
        ALIAS_SSH_URL,
        {},
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("private");
      expect(stub.calls).toEqual([["ssh", "-G", "gh-alias"], ALIAS_GH_ARGS]);
    });

    test("should read a failed ssh -G as public", async () => {
      // Arrange
      const stub = runStub({ ssh: () => commandOutput(255, "") });

      // Act
      const visibility = await readVisibility(
        ALIAS_ORIGIN,
        { MKSYNC_VISIBILITY: "private" },
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("public");
      expect(stub.calls).toEqual([["ssh", "-G", "gh-alias"]]);
    });

    test("should read the variable for an SSH host that is not github.com", async () => {
      // Arrange
      const stub = runStub({ ssh: () => sshHostname("gitlab.example.com") });

      // Act
      const visibility = await readVisibility(
        "git@gitlab-alias:o/r.git",
        { MKSYNC_VISIBILITY: "private" },
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("private");
      expect(stub.calls).toEqual([["ssh", "-G", "gitlab-alias"]]);
    });

    test("should never pass a host starting with - to ssh", async () => {
      // Arrange
      const stub = runStub({});

      // Act
      const visibility = await readVisibility(
        "-oProxyCommand=x:o/r",
        { MKSYNC_VISIBILITY: "private" },
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("public");
      expect(stub.calls).toEqual([]);
    });

    test("should never call ssh for a local path", async () => {
      // Arrange
      const stub = runStub({});

      // Act
      const visibility = await readVisibility(
        "/srv/git/repo.git",
        { MKSYNC_VISIBILITY: "private" },
        deps({ run: stub.run }),
      );

      // Assert
      expect(visibility).toBe("private");
      expect(stub.calls).toEqual([]);
    });
  });
});
