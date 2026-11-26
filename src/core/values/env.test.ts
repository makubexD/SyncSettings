import { describe, expect, test } from "bun:test";
import { valueEnv } from "./env.ts";

const WINDOWS_HOME = "C:\\Users\\u";

const LINUX_HOME = "/home/user";

const OTHER_NAME = "PARITY_BASE";

const OTHER_VALUE = "/srv/base";

describe("valueEnv", () => {
  test("should give HOME the home folder when the variable is unset", () => {
    // Act
    const env = valueEnv({ USERPROFILE: WINDOWS_HOME }, WINDOWS_HOME);

    // Assert
    expect(env.HOME).toBe(WINDOWS_HOME);
  });

  test("should give HOME the home folder over a variable that differs", () => {
    // Act
    const env = valueEnv({ HOME: "/c/Users/u" }, WINDOWS_HOME);

    // Assert
    expect(env.HOME).toBe(WINDOWS_HOME);
  });

  test("should keep the Linux home", () => {
    // Act
    const env = valueEnv({ HOME: LINUX_HOME }, LINUX_HOME);

    // Assert
    expect(env.HOME).toBe(LINUX_HOME);
  });

  test("should leave the environment as it is when the home is empty", () => {
    // Arrange
    const given = { [OTHER_NAME]: OTHER_VALUE };

    // Act
    const env = valueEnv(given, "");

    // Assert
    expect(env).toBe(given);
  });

  test("should keep any other variable", () => {
    // Act
    const env = valueEnv({ [OTHER_NAME]: OTHER_VALUE }, LINUX_HOME);

    // Assert
    expect(env[OTHER_NAME]).toBe(OTHER_VALUE);
  });
});
