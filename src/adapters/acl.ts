import { spawnSync } from "node:child_process";

/** The variable that hands the script its path, so no text is interpolated. */
export const PATH_VARIABLE = "MKSYNC_PRIVATE_PATH";

/**
 * Windows PowerShell 5.1, which every Windows ships, run with no profile and
 * no prompt.
 */
const POWERSHELL = "powershell.exe";

/**
 * Replace the file's whole access list with one rule, FullControl for the
 * current user's SID, and protect it from inheritance. A fresh `FileSecurity`
 * holds no other rule, so explicit grants already on the file (SYSTEM and
 * Administrators from a token's default DACL) are dropped too, which
 * `icacls /grant:r` would keep. The SID comes from the token, so no domain is
 * asked; `[IO.File]::SetAccessControl` sets no owner, unlike `Set-Acl`. Same
 * calls as the PowerShell engine's `Save-UserValues`.
 */
const OWNER_ONLY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  `  $path = $env:${PATH_VARIABLE}`,
  "  $acl = New-Object System.Security.AccessControl.FileSecurity",
  "  $acl.SetAccessRuleProtection($true, $false)",
  "  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')",
  "  $acl.AddAccessRule($rule)",
  "  [IO.File]::SetAccessControl($path, $acl)",
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "}",
].join("\n");

/** One process run: the program, its arguments and the variables it adds. */
export interface OwnerOnlyCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The PowerShell run that makes `path` readable by the current user only. The
 * script is fixed text; `path` reaches it only through `PATH_VARIABLE`.
 */
export function ownerOnlyCommand(path: string): OwnerOnlyCommand {
  return {
    file: POWERSHELL,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      OWNER_ONLY_SCRIPT,
    ],
    env: { [PATH_VARIABLE]: path },
  };
}

/**
 * Make `path` readable by the current user only, by SID, dropping every other
 * rule. POSIX modes are set by the caller, so this does nothing outside
 * Windows. Throws when PowerShell can't run or fails.
 */
export function restrictToCurrentUser(path: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const command = ownerOnlyCommand(path);
  const result = spawnSync(command.file, command.args, {
    encoding: "utf8",
    env: { ...process.env, ...command.env },
  });
  if (result.error !== undefined) {
    throw new Error(`${command.file} could not run`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command.file} could not restrict ${path}: ${result.stderr.trim()}`,
    );
  }
}
