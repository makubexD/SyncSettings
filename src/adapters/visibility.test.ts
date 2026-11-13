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

const GH_ARGS = ["gh", "repo", "view", SLUG, "--json", "visibility"];

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
];

/** Origins that name no repo on `github.com`, including look-alikes. */
const OTHER_ORIGINS: readonly string[] = [
  "/tmp/fixtures/bare.git",
  "https://gitlab.com/someone/repo",
  "git@bitbucket.org:team/repo.git",
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
  } = {},
): VisibilityDeps {
  return {
    run: options.run ?? (() => Promise.reject(new Error("gh must not run"))),
    fetch:
      options.fetch ??
      (() => Promise.reject(new Error("the API must not be called"))),
  };
}

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
});
