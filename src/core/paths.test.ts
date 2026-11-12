import { describe, expect, test } from "bun:test";
import { expandHome } from "./paths.ts";

const LINUX_HOME = "/home/user";
const WINDOWS_HOME = "C:\\Users\\user";
const LINUX_HOME_TRAILING = "/home/user/";
const WINDOWS_HOME_TRAILING = "C:\\Users\\user\\";

describe("expandHome", () => {
  test("should expand ~/ against the Linux home folder", () => {
    // Act
    const expanded = expandHome("~/a/b", "linux", LINUX_HOME);

    // Assert
    expect(expanded).toBe("/home/user/a/b");
  });

  test("should expand ~/ against the Windows home folder with backslashes", () => {
    // Act
    const expanded = expandHome("~/a/b", "windows", WINDOWS_HOME);

    // Assert
    expect(expanded).toBe("C:\\Users\\user\\a\\b");
  });

  test("should expand ~\\ on Windows", () => {
    // Act
    const expanded = expandHome("~\\a", "windows", WINDOWS_HOME);

    // Assert
    expect(expanded).toBe("C:\\Users\\user\\a");
  });

  test("should leave ~\\ unchanged on Linux", () => {
    // Act
    const expanded = expandHome("~\\a", "linux", LINUX_HOME);

    // Assert
    expect(expanded).toBe("~\\a");
  });

  test("should return the home folder for a bare ~", () => {
    // Act
    const linux = expandHome("~", "linux", LINUX_HOME);
    const windows = expandHome("~", "windows", WINDOWS_HOME);

    // Assert
    expect(linux).toBe(LINUX_HOME);
    expect(windows).toBe(WINDOWS_HOME);
  });

  test("should leave a path without ~ unchanged on Linux", () => {
    // Act
    const expanded = expandHome("/etc/x", "linux", LINUX_HOME);

    // Assert
    expect(expanded).toBe("/etc/x");
  });

  test("should turn / into \\ in a path without ~ on Windows", () => {
    // Act
    const expanded = expandHome("C:/x/y", "windows", WINDOWS_HOME);

    // Assert
    expect(expanded).toBe("C:\\x\\y");
  });

  test("should keep one separator when the home folder ends with one", () => {
    // Act
    const linux = expandHome("~/a", "linux", LINUX_HOME_TRAILING);
    const windows = expandHome("~/a", "windows", WINDOWS_HOME_TRAILING);

    // Assert
    expect(linux).toBe("/home/user/a");
    expect(windows).toBe("C:\\Users\\user\\a");
  });
});
