import { describe, expect, test } from "bun:test";
import type { SanitizeRule, SuggestSource } from "../core/config/types.ts";
import { sourceCommand, suggestions } from "./suggest.ts";
import type { SuggestResult, SuggestRunner } from "./suggest.ts";

const LOGIN_PLACEHOLDER = "<YOUR_GH_USERNAME>";

const NAME_PLACEHOLDER = "<YOUR_NAME>";

const LOGIN_RULE: SanitizeRule = {
  placeholder: LOGIN_PLACEHOLDER,
  prompt: "GitHub username",
  suggest: "gh-login",
};

const NAME_RULE: SanitizeRule = {
  placeholder: NAME_PLACEHOLDER,
  prompt: "Full name",
  suggest: "git-user-name",
};

const NO_ENV = {};

/** A runner that answers every command with `result` and records the calls. */
function answering(result: SuggestResult): {
  readonly runner: SuggestRunner;
  readonly calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv);
      return result;
    },
  };
}

describe("sourceCommand", () => {
  test.each<[SuggestSource, readonly string[]]>([
    ["gh-login", ["gh", "api", "user", "--jq", ".login"]],
    ["git-user-name", ["git", "config", "--global", "user.name"]],
    ["git-user-email", ["git", "config", "--global", "user.email"]],
  ])("should run %s as its command", (source, argv) => {
    expect(sourceCommand(source, NO_ENV)).toEqual(argv);
  });

  test("should run the gh that GH names", () => {
    expect(sourceCommand("gh-login", { GH: "/opt/gh" })[0]).toBe("/opt/gh");
  });
});

describe("suggestions", () => {
  test("should take a source's one line, trimmed", async () => {
    // Arrange
    const { runner } = answering({ code: 0, stdout: "  parity-user\r\n" });

    // Act
    const found = await suggestions([LOGIN_RULE], runner, NO_ENV);

    // Assert
    expect(found).toEqual({ [LOGIN_PLACEHOLDER]: "parity-user" });
  });

  test("should give no suggestion when gh fails", async () => {
    const { runner } = answering({ code: 1, stdout: "parity-user\n" });

    expect(await suggestions([LOGIN_RULE], runner, NO_ENV)).toEqual({});
  });

  test.each([
    "",
    "\n",
    "<YOUR_GH_USERNAME>\n",
    "two\nlines\n",
    "Ana\u001b[31mLopez\n",
    "Ana\u009bLopez\n",
  ])("should give no suggestion for the output %p", async (stdout) => {
    const { runner } = answering({ code: 0, stdout });

    expect(await suggestions([LOGIN_RULE], runner, NO_ENV)).toEqual({});
  });

  test("should give no suggestion when the runner rejects", async () => {
    const runner = (): Promise<never> => Promise.reject(new Error("spawn"));

    expect(await suggestions([LOGIN_RULE], runner, NO_ENV)).toEqual({});
  });

  test("should run each source once however many rules name it", async () => {
    const { runner, calls } = answering({ code: 0, stdout: "Ana Lopez\n" });
    const other = { ...NAME_RULE, placeholder: "<OTHER_NAME>" };

    const found = await suggestions([NAME_RULE, other], runner, NO_ENV);

    expect(calls).toHaveLength(1);
    expect(found).toEqual({
      [NAME_PLACEHOLDER]: "Ana Lopez",
      "<OTHER_NAME>": "Ana Lopez",
    });
  });

  test("should run nothing for rules without suggest", async () => {
    const { runner, calls } = answering({ code: 0, stdout: "x\n" });
    const plain = { placeholder: NAME_PLACEHOLDER, prompt: "Full name" };

    expect(await suggestions([plain], runner, NO_ENV)).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
