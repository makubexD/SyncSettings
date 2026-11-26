import { describe, expect, test } from "bun:test";
import { valueEnv } from "./env.ts";

const WINDOWS_HOME = "C:\\Users\\u";

const WINDOWS_HOME_FORWARD = "C:/Users/u";

const LINUX_HOME = "/home/user";

const OTHER_NAME = "PARITY_BASE";

const OTHER_VALUE = "/srv/base";

describe("valueEnv", () => {
  test("should give HOME the Windows home with forward slashes when the variable is unset", () => {
    // Act
    const env = valueEnv(
      { USERPROFILE: WINDOWS_HOME },
      WINDOWS_HOME,
      "windows",
    );

    // Assert
    expect(env.HOME).toBe(WINDOWS_HOME_FORWARD);
  });

  test("should give HOME the home folder over a variable that differs", () => {
    // Act
    const env = valueEnv({ HOME: "/c/Users/u" }, WINDOWS_HOME, "windows");

    // Assert
    expect(env.HOME).toBe(WINDOWS_HOME_FORWARD);
  });

  test("should keep the Linux home", () => {
    // Act
    const env = valueEnv({ HOME: LINUX_HOME }, LINUX_HOME, "linux");

    // Assert
    expect(env.HOME).toBe(LINUX_HOME);
  });

  test("should keep a backslash in a home off Windows", () => {
    // Act
    const env = valueEnv({}, "/home/a\\b", "macos");

    // Assert
    expect(env.HOME).toBe("/home/a\\b");
  });

  test("should leave the environment as it is when the home is empty", () => {
    // Arrange
    const given = { [OTHER_NAME]: OTHER_VALUE };

    // Act
    const env = valueEnv(given, "", "windows");

    // Assert
    expect(env).toBe(given);
  });

  test("should keep any other variable", () => {
    // Act
    const env = valueEnv({ [OTHER_NAME]: OTHER_VALUE }, LINUX_HOME, "linux");

    // Assert
    expect(env[OTHER_NAME]).toBe(OTHER_VALUE);
  });
});
