import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readGitFacts, tildePath } from "./gitconfig.ts";
import type { GitConfigResult, GitConfigRunner } from "./gitconfig.ts";

const HOME = "/home/u";

const NO_MATCH: GitConfigResult = { code: 1, stdout: "" };

/** A runner answering the plain and the conditional include calls. */
function runner(
  plain: GitConfigResult,
  conditional: GitConfigResult,
): GitConfigRunner {
  return async (args) => (args.includes("--get-all") ? plain : conditional);
}

function existsWith(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe("readGitFacts", () => {
  test("should read both include kinds, home written as ~", async () => {
    // Arrange
    const git = runner(
      { code: 0, stdout: `${HOME}/.gitconfig.local\0` },
      {
        code: 0,
        stdout: `includeif.gitdir:~/work/.path\n${HOME}/work/.gitconfig\0`,
      },
    );

    // Act
    const facts = await readGitFacts(HOME, git, existsWith());

    // Assert
    expect(facts.includes).toEqual(["~/.gitconfig.local", "~/work/.gitconfig"]);
  });

  test("should keep a path with a space whole", async () => {
    const git = runner({ code: 0, stdout: "/srv/my config\0" }, NO_MATCH);

    const facts = await readGitFacts(HOME, git, existsWith());

    expect(facts.includes).toEqual(["/srv/my config"]);
  });

  test("should read no includes when git finds none or fails", async () => {
    const facts = await readGitFacts(
      HOME,
      runner(NO_MATCH, { code: 127, stdout: "" }),
      existsWith(),
    );

    expect(facts.includes).toEqual([]);
  });

  test("should check the XDG file and the local file under home", async () => {
    const facts = await readGitFacts(
      HOME,
      runner(NO_MATCH, NO_MATCH),
      existsWith(join(HOME, ".config", "git", "config")),
    );

    expect(facts.xdgConfig).toBe(true);
    expect(facts.localExists).toBe(false);
  });

  test("should see the local file when it exists", async () => {
    const facts = await readGitFacts(
      HOME,
      runner(NO_MATCH, NO_MATCH),
      existsWith(join(HOME, ".gitconfig.local")),
    );

    expect(facts.xdgConfig).toBe(false);
    expect(facts.localExists).toBe(true);
  });
});

describe("tildePath", () => {
  test.each([
    ["/home/u/work/.gitconfig", "/home/u", "~/work/.gitconfig"],
    ["/home/user/x", "/home/u", "/home/user/x"],
    ["C:\\Users\\u\\w\\.gitconfig", "C:\\Users\\u", "~\\w\\.gitconfig"],
    ["C:/Users/u/w/.gitconfig", "C:\\Users\\u", "~/w/.gitconfig"],
    ["~/a", "/home/u", "~/a"],
  ])("should write %s under %s as %s", (path, home, expected) => {
    expect(tildePath(path, home)).toBe(expected);
  });
});
