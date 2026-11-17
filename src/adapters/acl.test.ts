import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ownerOnlyCommand,
  PATH_VARIABLE,
  restrictToCurrentUser,
} from "./acl.ts";

/** A path with a quote, `$` and `;`, which must never reach the script text. */
const HOSTILE_PATH = "C:\\r\\it's $(x); .user-values.json";
const FILE_MODE = 0o640;
const MODE_MASK = 0o777;

function script(): string {
  const args = ownerOnlyCommand(HOSTILE_PATH).args;
  return args[args.length - 1] ?? "";
}

describe("ownerOnlyCommand", () => {
  test("should pass the path only through the environment", () => {
    // Act
    const command = ownerOnlyCommand(HOSTILE_PATH);

    // Assert
    expect(command.env).toEqual({ [PATH_VARIABLE]: HOSTILE_PATH });
    expect(command.args.join(" ")).not.toContain(HOSTILE_PATH);
  });

  test("should replace the whole list, protected from inheritance (values-private-tightened)", () => {
    // Act
    const text = script();

    // Assert
    expect(text).toContain(
      "New-Object System.Security.AccessControl.FileSecurity",
    );
    expect(text).toContain("SetAccessRuleProtection($true, $false)");
    expect(text).toContain("[IO.File]::SetAccessControl($path, $acl)");
  });

  test("should grant the token's SID, with no name or domain (values-private-no-domain)", () => {
    // Act
    const text = script();

    // Assert
    expect(text).toContain(
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    );
    expect(text).not.toContain("Set-Acl");
    expect(text).not.toContain("NTAccount");
  });

  test("should exit 1 when the script fails", () => {
    // Act
    const text = script();

    // Assert
    expect(text).toContain("$ErrorActionPreference = 'Stop'");
    expect(text).toContain("exit 1");
  });

  test("should run Windows PowerShell with no profile or prompt", () => {
    // Act
    const command = ownerOnlyCommand(HOSTILE_PATH);

    // Assert
    expect(command.file).toBe("powershell.exe");
    expect(command.args).toContain("-NoProfile");
    expect(command.args).toContain("-NonInteractive");
  });
});

describe("restrictToCurrentUser", () => {
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "should leave the mode unchanged outside Windows",
    () => {
      // Arrange
      const folder = mkdtempSync(join(tmpdir(), "mksync-acl-"));
      folders.push(folder);
      const path = join(folder, "file");
      writeFileSync(path, "x");
      chmodSync(path, FILE_MODE);

      // Act
      restrictToCurrentUser(path);

      // Assert
      expect(statSync(path).mode & MODE_MASK).toBe(FILE_MODE);
    },
  );
});
