import { describe, expect, test } from "bun:test";
import type { SanitizeRule, SuggestSource } from "../core/config/types.ts";
import { sourceCommand, suggestions } from "./suggest.ts";
import type {
  SourceContext,
  SuggestContext,
  SuggestResult,
  SuggestRunner,
} from "./suggest.ts";

const LOGIN_PLACEHOLDER = "<YOUR_GH_USERNAME>";

const NAME_PLACEHOLDER = "<YOUR_NAME>";

const OWNER_PLACEHOLDER = "<YOUR_GH_OWNER>";

const GH_PATH_PLACEHOLDER = "<GH_CLI_PATH>";

const REPO_ROOT = "/clone";

const USER_NAME = "parity";

const FOUND_GH = "/usr/bin/gh";

const LOGIN_RULE: SanitizeRule = {
  placeholder: LOGIN_PLACEHOLDER,
  prompt: "GitHub username",
  suggest: ["gh-login"],
};

const NAME_RULE: SanitizeRule = {
  placeholder: NAME_PLACEHOLDER,
  prompt: "Full name",
  suggest: ["git-user-name"],
};

const OWNER_RULE: SanitizeRule = {
  placeholder: OWNER_PLACEHOLDER,
  prompt: "GitHub owner",
  suggest: ["origin-owner"],
};

const PASSWD_RULE: SanitizeRule = {
  placeholder: NAME_PLACEHOLDER,
  prompt: "Full name",
  suggest: ["passwd-name"],
};

const NO_ENV = {};

const LINUX_SOURCE: SourceContext = {
  env: NO_ENV,
  platform: "linux",
  repoRoot: REPO_ROOT,
  userName: USER_NAME,
};

/** A context that runs `runner` on Linux with nothing else from the machine. */
function linux(runner: SuggestRunner): SuggestContext {
  return {
    runner,
    env: NO_ENV,
    platform: "linux",
    repoRoot: REPO_ROOT,
    userName: USER_NAME,
    findGh: () => null,
  };
}

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

/** A runner that answers by the command's program and records the calls. */
function byProgram(results: Readonly<Record<string, SuggestResult>>): {
  readonly runner: SuggestRunner;
  readonly calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv);
      return results[argv[0] ?? ""] ?? { code: 1, stdout: "" };
    },
  };
}

describe("sourceCommand", () => {
  test.each<[SuggestSource, readonly string[]]>([
    ["gh-login", ["gh", "api", "user", "--jq", ".login"]],
    ["gh-hosts-login", ["gh", "config", "get", "-h", "github.com", "user"]],
    ["origin-owner", ["git", "-C", REPO_ROOT, "remote", "get-url", "origin"]],
    ["git-user-name", ["git", "config", "--global", "user.name"]],
    ["git-user-email", ["git", "config", "--global", "user.email"]],
    ["passwd-name", ["getent", "passwd", USER_NAME]],
  ])("should run %s as its command", (source, argv) => {
    expect(sourceCommand(source, LINUX_SOURCE)).toEqual(argv);
  });

  test("should run the gh that GH names", () => {
    // Arrange
    const context = { ...LINUX_SOURCE, env: { GH: "/opt/gh" } };

    // Act
    const argv = sourceCommand("gh-hosts-login", context);

    // Assert
    expect(argv?.[0]).toBe("/opt/gh");
  });

  test("should read the full name with id -F on macOS", () => {
    expect(
      sourceCommand("passwd-name", { ...LINUX_SOURCE, platform: "darwin" }),
    ).toEqual(["id", "-F"]);
  });

  test.each<[string, SuggestSource, SourceContext]>([
    ["gh-path, which is found, not run", "gh-path", LINUX_SOURCE],
    [
      "passwd-name on Windows",
      "passwd-name",
      { ...LINUX_SOURCE, platform: "win32" },
    ],
    [
      "origin-owner without a clone",
      "origin-owner",
      { env: NO_ENV, platform: "linux" },
    ],
  ])("should run nothing for %s", (_label, source, context) => {
    expect(sourceCommand(source, context)).toBeUndefined();
  });
});

describe("suggestions", () => {
  test("should take a source's one line, trimmed", async () => {
    // Arrange
    const { runner } = answering({ code: 0, stdout: "  parity-user\r\n" });

    // Act
    const found = await suggestions([LOGIN_RULE], linux(runner));

    // Assert
    expect(found).toEqual({ [LOGIN_PLACEHOLDER]: "parity-user" });
  });

  test("should give no suggestion when gh fails", async () => {
    const { runner } = answering({ code: 1, stdout: "parity-user\n" });

    expect(await suggestions([LOGIN_RULE], linux(runner))).toEqual({});
  });

  test.each([
    "",
    "\n",
    "<YOUR_GH_USERNAME>\n",
    "two\nlines\n",
    "Ana\u001b[31mLopez\n",
    "Ana\u009bLopez\n",
    "Ana\u202eLopez\n",
    "Ana\u200bLopez\n",
    "Ana\u2028Lopez\n",
  ])("should give no suggestion for the output %p", async (stdout) => {
    const { runner } = answering({ code: 0, stdout });

    expect(await suggestions([LOGIN_RULE], linux(runner))).toEqual({});
  });

  test("should give no suggestion when the runner rejects", async () => {
    const runner = (): Promise<never> => Promise.reject(new Error("spawn"));

    expect(await suggestions([LOGIN_RULE], linux(runner))).toEqual({});
  });

  test("should run each source once however many rules name it", async () => {
    // Arrange
    const { runner, calls } = answering({ code: 0, stdout: "Ana Lopez\n" });
    const other = { ...NAME_RULE, placeholder: "<OTHER_NAME>" };

    // Act
    const found = await suggestions([NAME_RULE, other], linux(runner));

    // Assert
    expect(calls).toHaveLength(1);
    expect(found).toEqual({
      [NAME_PLACEHOLDER]: "Ana Lopez",
      "<OTHER_NAME>": "Ana Lopez",
    });
  });

  test("should run nothing for rules without suggest", async () => {
    // Arrange
    const { runner, calls } = answering({ code: 0, stdout: "x\n" });
    const plain = { placeholder: NAME_PLACEHOLDER, prompt: "Full name" };

    // Act
    const found = await suggestions([plain], linux(runner));

    // Assert
    expect(found).toEqual({});
    expect(calls).toHaveLength(0);
  });

  test.each([
    "https://github.com/parity-owner/SyncSettings.git",
    "git@github.com:parity-owner/SyncSettings.git",
    "ssh://git@github.com/parity-owner/SyncSettings",
  ])("should take the owner from the origin %s", async (origin) => {
    const { runner } = answering({ code: 0, stdout: `${origin}\n` });

    expect(await suggestions([OWNER_RULE], linux(runner))).toEqual({
      [OWNER_PLACEHOLDER]: "parity-owner",
    });
  });

  test("should give no owner for an origin on another host", async () => {
    const { runner } = answering({
      code: 0,
      stdout: "https://gitlab.com/parity-owner/SyncSettings.git\n",
    });

    expect(await suggestions([OWNER_RULE], linux(runner))).toEqual({});
  });

  test("should take the passwd full name up to its first comma", async () => {
    const { runner } = answering({
      code: 0,
      stdout: "parity:x:1000:1000:Ana Lopez,,,:/home/parity:/bin/bash\n",
    });

    expect(await suggestions([PASSWD_RULE], linux(runner))).toEqual({
      [NAME_PLACEHOLDER]: "Ana Lopez",
    });
  });

  test("should give no name when the passwd full-name field is empty", async () => {
    const { runner } = answering({
      code: 0,
      stdout: "parity:x:1000:1000::/home/parity:/bin/bash\n",
    });

    expect(await suggestions([PASSWD_RULE], linux(runner))).toEqual({});
  });

  test("should take the second source when the first fails", async () => {
    // Arrange
    const { runner, calls } = byProgram({
      git: { code: 0, stdout: "git@github.com:parity-owner/repo.git\n" },
    });
    const rule = {
      ...OWNER_RULE,
      suggest: ["gh-hosts-login", "origin-owner"] as const,
    };

    // Act
    const found = await suggestions([rule], linux(runner));

    // Assert
    expect(calls.map((argv) => argv[0])).toEqual(["gh", "git"]);
    expect(found).toEqual({ [OWNER_PLACEHOLDER]: "parity-owner" });
  });

  test("should not run a later source when the first answers", async () => {
    // Arrange
    const { runner, calls } = answering({ code: 0, stdout: "parity-user\n" });
    const rule = {
      ...OWNER_RULE,
      suggest: ["gh-hosts-login", "origin-owner"] as const,
    };

    // Act
    await suggestions([rule], linux(runner));

    // Assert
    expect(calls).toHaveLength(1);
  });

  test("should give no suggestion when every source fails", async () => {
    // Arrange
    const { runner } = answering({ code: 1, stdout: "" });
    const rule = {
      ...OWNER_RULE,
      suggest: ["gh-hosts-login", "origin-owner", "gh-path"] as const,
    };

    // Act
    const found = await suggestions([rule], linux(runner));

    // Assert
    expect(found).toEqual({});
  });

  test("should suggest the gh found on PATH without running it", async () => {
    // Arrange
    const { runner, calls } = answering({ code: 0, stdout: "x\n" });
    const rule = {
      placeholder: GH_PATH_PLACEHOLDER,
      prompt: "gh",
      suggest: ["gh-path"] as const,
    };

    // Act
    const found = await suggestions([rule], {
      ...linux(runner),
      findGh: () => FOUND_GH,
    });

    // Assert
    expect(found).toEqual({ [GH_PATH_PLACEHOLDER]: FOUND_GH });
    expect(calls).toHaveLength(0);
  });
});
