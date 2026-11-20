<#
.SYNOPSIS
    Checks install.ps1 in the Windows VM: a folder release served over file://,
    a bare origin built from this copy of the working tree, a fake program
    that logs its arguments, and stubs for gh and git. Prints
    `install-check: ok` and exits 0, or the failed check and exits 1.
.DESCRIPTION
    Run from the repo copy in the VM:
        powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-vm/install-check.ps1

    Every run of install.ps1 goes through powershell.exe -File, so its last
    line exits with the installer's code. The throwaway LOCALAPPDATA holds the
    bin folder, and the real user Path is saved and put back around each run.
#>

$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$T = Join-Path $env:TEMP ('install-check-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $T -Force

$Src = Join-Path $T 'src'
$Origin = Join-Path $T 'origin.git'
$InstallDir = Join-Path $T 'install'
$AppData = Join-Path $T 'localappdata'
$Bin = Join-Path $AppData 'mksync'
$Release = Join-Path $T 'release'
$TagDir = Join-Path $Release 'download\v9.9.9'
$ReleaseUrl = 'file:///' + $Release.Replace('\', '/')
$Log = Join-Path $T 'program.log'
$Program = Join-Path $T 'fake-program.exe'
$Asset = 'mksync-windows-x64.exe'

# The real user Path, LOCALAPPDATA and the installer settings, put back
# around every run.
$SavedUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$SavedLocalAppData = $env:LOCALAPPDATA

$null = New-Item -ItemType Directory -Path $AppData -Force
$env:LOCALAPPDATA = $AppData
$SettingNames = @(
    'SYNCSETTINGS_REPO_URL', 'SYNCSETTINGS_DIR', 'SYNCSETTINGS_REF', 'SYNCSETTINGS_BIN',
    'SYNCSETTINGS_YES', 'SYNCSETTINGS_NO_SETUP', 'SYNCSETTINGS_RELEASE_URL',
    'SYNCSETTINGS_RUNTIME', 'SYNC_ARCH'
)
$SavedSettings = @{}
foreach ($name in $SettingNames) {
    $SavedSettings[$name] = [Environment]::GetEnvironmentVariable($name)
}

function Restore-Settings {
    [Environment]::SetEnvironmentVariable('Path', $SavedUserPath, 'User')
    if ($null -eq $SavedLocalAppData) {
        Remove-Item Env:\LOCALAPPDATA -ErrorAction SilentlyContinue
    } else {
        $env:LOCALAPPDATA = $SavedLocalAppData
    }
    foreach ($name in $SettingNames) {
        [Environment]::SetEnvironmentVariable($name, $SavedSettings[$name])
    }
}

function Stop-Check {
    param([string]$Message)
    Restore-Settings
    Write-Output "install-check: $Message"
    exit 1
}

# An unexpected error still reports as a failed check, with the Path restored.
trap {
    Stop-Check "$_"
}

# Runs install.ps1 the way a user does: -File, so its last line exits with
# Install-SyncSettings' code. -Settings overrides the defaults and a $null
# removes that variable; every other SYNCSETTINGS_* variable is removed.
# -PathPrefix puts the case's stub folders ahead of the real Path.
function Invoke-Install {
    param([hashtable]$Settings = @{}, [string[]]$PathPrefix = @())
    $config = @{
        SYNCSETTINGS_REPO_URL = $Origin
        SYNCSETTINGS_DIR = $InstallDir
        SYNCSETTINGS_REF = 'master'
        SYNCSETTINGS_RELEASE_URL = $ReleaseUrl
        SYNCSETTINGS_YES = '1'
    }
    foreach ($name in @($Settings.Keys)) {
        $config[$name] = $Settings[$name]
    }
    foreach ($name in $SettingNames) {
        if ($config.ContainsKey($name)) {
            [Environment]::SetEnvironmentVariable($name, [string]$config[$name])
        } else {
            [Environment]::SetEnvironmentVariable($name, $null)
        }
    }
    $savedPath = $env:Path
    if ($PathPrefix.Count -gt 0) {
        $env:Path = ($PathPrefix -join ';') + ';' + $savedPath
    }
    try {
        $script:InstallOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'install.ps1') 2>&1 | Out-String
        $script:InstallExit = $LASTEXITCODE
    } finally {
        $env:Path = $savedPath
        [Environment]::SetEnvironmentVariable('Path', $SavedUserPath, 'User')
    }
    return @{ Out = $script:InstallOut; Exit = $script:InstallExit }
}

# Writes SHA256SUMS for the release asset, with the digest given.
function Write-Sums {
    param([string]$Hash)
    $text = $Hash.ToLowerInvariant() + '  ' + $Asset + "`n"
    [IO.File]::WriteAllText((Join-Path $TagDir 'SHA256SUMS'), $text, $Utf8)
}

# Clears what the previous check installed.
function Reset-Bin {
    if (Test-Path -LiteralPath $Bin) {
        Remove-Item -LiteralPath $Bin -Recurse -Force
    }
}

# 1. A bare origin built from the working tree, as the Pester install cases
#    build one: the VM copy has no .git of its own.
robocopy $Repo $Src /MIR /A-:RHS /NFL /NDL /NJH /NJS /NP /XD .git node_modules | Out-Null
if ($LASTEXITCODE -ge 8) {
    Stop-Check "could not copy the working tree (robocopy $LASTEXITCODE)"
}
# A worktree's .git is a file, which /XD (folders only) leaves behind; the copy
# is its own new repo.
if (Test-Path -LiteralPath (Join-Path $Src '.git')) {
    Remove-Item -LiteralPath (Join-Path $Src '.git') -Recurse -Force
}
git -C $Src init -q -b master 2>$null
git -C $Src config core.autocrlf false 2>$null
git -C $Src add -A 2>$null
git -C $Src -c user.name=t -c user.email=t@example.com commit -q -m init 2>$null
git init -q --bare -b master $Origin 2>$null
git -C $Src remote add origin $Origin 2>$null
git -C $Src push -q origin master 2>$null
if (-not (Test-Path -LiteralPath (Join-Path $Origin 'refs\heads\master'))) {
    Stop-Check 'could not build the bare origin'
}

# 2. A fake program that appends its arguments to a log and exits 0, and a
#    folder release holding it as the x64 asset.
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$source = @"
public class MksyncCheckProgram {
    public static int Main(string[] args) {
        System.IO.File.AppendAllText(@"$Log", string.Join(" ", args) + "\n");
        return 0;
    }
}
"@
Add-Type -TypeDefinition $source -OutputType ConsoleApplication -OutputAssembly $Program

$null = New-Item -ItemType Directory -Path $TagDir -Force
[IO.File]::WriteAllText((Join-Path $Release 'latest'), "v9.9.9`n", $Utf8)
Copy-Item -LiteralPath $Program -Destination (Join-Path $TagDir $Asset)
$ProgramHash = (Get-FileHash -LiteralPath $Program -Algorithm SHA256).Hash
Write-Sums $ProgramHash

# 2b. A gh stub: every call is logged to gh.log, auth status fails while the
#     gh-not-signed-in file is in the folder, release view prints the case's
#     latest tag, and release download copies the -p files out of the folder
#     release into -D. Its folder has a space in the name, as the GitHub CLI's
#     own does; the clone's credential helper names gh bare, found on PATH.
$GhStubDir = Join-Path $T 'gh stub'
$GhStub = Join-Path $GhStubDir 'gh.cmd'
$GhLog = Join-Path $GhStubDir 'gh.log'
$GhNotSignedIn = Join-Path $GhStubDir 'gh-not-signed-in'
$null = New-Item -ItemType Directory -Path $GhStubDir -Force
$ghLines = @(
    '@echo off',
    ('>> "' + $GhLog + '" echo gh %*'),
    'if /I "%~1"=="auth" goto auth',
    'if /I "%~1"=="release" goto release',
    'exit /b 0',
    '',
    ':auth',
    ('if exist "' + $GhNotSignedIn + '" exit /b 1'),
    'exit /b 0',
    '',
    ':release',
    'if /I "%~2"=="view" goto view',
    'if /I "%~2"=="download" goto download',
    'exit /b 1',
    '',
    ':view',
    ('type "' + (Join-Path $Release 'latest') + '"'),
    'exit /b 0',
    '',
    ':download',
    'set "tag=%~3"',
    'shift',
    'shift',
    'set "names="',
    'set "dir="',
    ':download_args',
    'if "%~1"=="" goto download_copy',
    'if /I "%~1"=="-p" (',
    '    set "names=%names% %~2"',
    '    shift',
    '    shift',
    '    goto download_args',
    ')',
    'if /I "%~1"=="-D" (',
    '    set "dir=%~2"',
    '    shift',
    '    shift',
    '    goto download_args',
    ')',
    'shift',
    'goto download_args',
    '',
    ':download_copy',
    ('for %%f in (%names%) do copy /Y "' + $Release + '\download\%tag%\%%~f" "%dir%\%%~f" >nul || exit /b 1'),
    'exit /b 0'
)
[IO.File]::WriteAllText($GhStub, (($ghLines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)

# 2c. A git stub: it logs the arguments it receives, one per line, then runs
#     the real git with the same ones.
$GitStubDir = Join-Path $T 'gitstub'
$GitStub = Join-Path $GitStubDir 'git.exe'
$GitLog = Join-Path $GitStubDir 'git.log'
$null = New-Item -ItemType Directory -Path $GitStubDir -Force
$RealGit = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$gitSource = @"
public class MksyncCheckGit {
    static string Quote(string s) {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"', '\n', '\v' }) < 0) {
            return s;
        }
        var sb = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char c in s) {
            if (c == '\\') {
                slashes++;
                continue;
            }
            if (c == '"') {
                sb.Append('\\', 2 * slashes + 1);
                sb.Append('"');
            } else {
                sb.Append('\\', slashes);
                sb.Append(c);
            }
            slashes = 0;
        }
        sb.Append('\\', 2 * slashes);
        sb.Append('"');
        return sb.ToString();
    }

    public static int Main(string[] args) {
        System.IO.File.AppendAllText(@"$GitLog", string.Join("\n", args) + "\n---\n");
        var info = new System.Diagnostics.ProcessStartInfo(@"$RealGit");
        info.UseShellExecute = false;
        var parts = new System.Collections.Generic.List<string>();
        foreach (string a in args) {
            parts.Add(Quote(a));
        }
        info.Arguments = string.Join(" ", parts.ToArray());
        var p = System.Diagnostics.Process.Start(info);
        p.WaitForExit();
        return p.ExitCode;
    }
}
"@
Add-Type -TypeDefinition $gitSource -OutputType ConsoleApplication -OutputAssembly $GitStub

# 3. The checks, in order; the first failure stops the script.
Remove-Item -LiteralPath $Log -Force -ErrorAction SilentlyContinue
Reset-Bin

# install: the fake program lands in bin, mode intact, and setup ran through it.
$run = Invoke-Install
$exe = Join-Path $Bin 'mksync.exe'
if ($run.Exit -ne 0) {
    Stop-Check "install: exit $($run.Exit)`n$($run.Out)"
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Stop-Check "install: no $exe`n$($run.Out)"
}
$installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($installedHash -ine $ProgramHash) {
    Stop-Check "install: $exe is not the released program"
}
if (-not (Test-Path -LiteralPath $Log)) {
    Stop-Check 'install: the program never ran'
}
if (([IO.File]::ReadAllText($Log)) -notmatch 'setup --yes') {
    Stop-Check "install: setup --yes never ran`n$([IO.File]::ReadAllText($Log))"
}

# checksum: a wrong SHA256SUMS gives its line, exit 1, and installs nothing.
Reset-Bin
Write-Sums ('0' * 64)
try {
    $run = Invoke-Install
} finally {
    Write-Sums $ProgramHash
}
if ($run.Exit -ne 1) {
    Stop-Check "checksum: exit $($run.Exit)`n$($run.Out)"
}
if ($run.Out -notmatch [regex]::Escape('ERROR: mksync-windows-x64.exe: checksum does not match SHA256SUMS.')) {
    Stop-Check "checksum: wrong line`n$($run.Out)"
}
if (Test-Path -LiteralPath $exe) {
    Stop-Check "checksum: $exe exists after the failed check"
}

# runtime: SYNCSETTINGS_RUNTIME=node writes the shim to the clone's launcher
# and never downloads (the release URL points at nothing).
Reset-Bin
$run = Invoke-Install -Settings @{
    SYNCSETTINGS_RUNTIME = 'node'
    SYNCSETTINGS_NO_SETUP = '1'
    SYNCSETTINGS_RELEASE_URL = ('file:///' + (Join-Path $T 'no-release').Replace('\', '/'))
}
if ($run.Exit -ne 0) {
    Stop-Check "runtime: exit $($run.Exit)`n$($run.Out)"
}
$shim = Join-Path $Bin 'mksync.cmd'
if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) {
    Stop-Check "runtime: no $shim`n$($run.Out)"
}
if (Test-Path -LiteralPath $exe) {
    Stop-Check "runtime: $exe exists"
}
$lines = [IO.File]::ReadAllLines($shim)
$want = 'call "' + (Join-Path $InstallDir 'mksync.cmd') + '" %*'
if ($lines.Count -lt 3 -or $lines[2].Trim() -ne $want) {
    Stop-Check "runtime: the shim does not call the clone's mksync.cmd`n$($lines -join "`n")"
}
$sh = Join-Path $Bin 'mksync'
if (-not (Test-Path -LiteralPath $sh -PathType Leaf)) {
    Stop-Check "runtime: no $sh`n$($run.Out)"
}
$wantSh = "#!/bin/sh`n# SyncSettings launcher`n" +
    'exec "' + $InstallDir.Replace('\', '/') + '/mksync" "$@"' + "`n"
$shText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($sh))
if ($shText -ne $wantSh) {
    Stop-Check "runtime: $sh is not the launcher`n$shText"
}

# program: installing the program removes both runtime launchers.
$run = Invoke-Install -Settings @{ SYNCSETTINGS_NO_SETUP = '1' }
if ($run.Exit -ne 0) {
    Stop-Check "program after runtime: exit $($run.Exit)`n$($run.Out)"
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Stop-Check "program after runtime: no $exe`n$($run.Out)"
}
if (Test-Path -LiteralPath $shim) {
    Stop-Check "program after runtime: $shim exists"
}
if (Test-Path -LiteralPath $sh) {
    Stop-Check "program after runtime: $sh exists"
}

# runtime-foreign: a mksync without the marker stops the runtime install,
# exit 1, and is left as it was.
Reset-Bin
$null = New-Item -ItemType Directory -Path $Bin -Force
$sh = Join-Path $Bin 'mksync'
$foreign = "#!/bin/sh`necho mine`n"
[IO.File]::WriteAllText($sh, $foreign, [Text.Encoding]::ASCII)
$run = Invoke-Install -Settings @{
    SYNCSETTINGS_RUNTIME = 'node'
    SYNCSETTINGS_NO_SETUP = '1'
    SYNCSETTINGS_RELEASE_URL = ('file:///' + (Join-Path $T 'no-release').Replace('\', '/'))
}
if ($run.Exit -ne 1) {
    Stop-Check "runtime-foreign: exit $($run.Exit)`n$($run.Out)"
}
if ($run.Out -notmatch [regex]::Escape("ERROR: $sh already exists; remove it and run this again.")) {
    Stop-Check "runtime-foreign: wrong line`n$($run.Out)"
}
$shText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($sh))
if ($shText -ne $foreign) {
    Stop-Check "runtime-foreign: $sh changed`n$shText"
}
if (Test-Path -LiteralPath $shim) {
    Stop-Check "runtime-foreign: $shim was written"
}

# arch: an arch with no program gives its line and exit 1.
Reset-Bin
$run = Invoke-Install -Settings @{ SYNC_ARCH = 'x86'; SYNCSETTINGS_NO_SETUP = '1' }
if ($run.Exit -ne 1) {
    Stop-Check "arch: exit $($run.Exit)`n$($run.Out)"
}
if ($run.Out -notmatch [regex]::Escape('ERROR: no mksync program for windows x86.')) {
    Stop-Check "arch: wrong line`n$($run.Out)"
}
if (Test-Path -LiteralPath $exe) {
    Stop-Check "arch: $exe exists"
}

# second: a second install over the same program exits 0 and leaves it alone.
Reset-Bin
$run = Invoke-Install
if ($run.Exit -ne 0) {
    Stop-Check "second: first install exit $($run.Exit)`n$($run.Out)"
}
$beforeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$beforeTime = (Get-Item -LiteralPath $exe).LastWriteTimeUtc
$run = Invoke-Install
if ($run.Exit -ne 0) {
    Stop-Check "second: exit $($run.Exit)`n$($run.Out)"
}
$afterHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$afterTime = (Get-Item -LiteralPath $exe).LastWriteTimeUtc
if ($afterHash -ne $beforeHash -or $afterTime -ne $beforeTime) {
    Stop-Check 'second: mksync.exe changed'
}

# gh-download: with gh signed in and no release URL, the tag and both release
# files come through gh. The empty release URL leaves the plain path pointing
# at github.com, so the program's hash proves the stub's copy is what landed.
Reset-Bin
Remove-Item -LiteralPath $GhLog -Force -ErrorAction SilentlyContinue
$run = Invoke-Install -Settings @{ SYNCSETTINGS_RELEASE_URL = '' } -PathPrefix @($GhStubDir)
if ($run.Exit -ne 0) {
    Stop-Check "gh-download: exit $($run.Exit)`n$($run.Out)"
}
$installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($installedHash -ine $ProgramHash) {
    Stop-Check 'gh-download: the program is not the release fixture'
}
$ghText = [IO.File]::ReadAllText($GhLog)
if (-not $ghText.Contains('gh release view --repo makubexD/SyncSettings --json tagName -q .tagName')) {
    Stop-Check "gh-download: gh release view did not name the tag`n$ghText"
}
if (-not $ghText.Contains('gh release download v9.9.9 --repo makubexD/SyncSettings -p mksync-windows-x64.exe -p SHA256SUMS -D ')) {
    Stop-Check "gh-download: gh release download did not fetch the asset and SHA256SUMS`n$ghText"
}

# gh-clone: with gh signed in and no release URL, the clone carries gh's
# credential helper as -c options for that one command, and it still clones
# the case's local origin.
Reset-Bin
if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
Remove-Item -LiteralPath $GhLog, $GitLog -Force -ErrorAction SilentlyContinue
$run = Invoke-Install -Settings @{
    SYNCSETTINGS_RELEASE_URL = ''
    SYNCSETTINGS_NO_SETUP = '1'
} -PathPrefix @($GhStubDir, $GitStubDir)
if ($run.Exit -ne 0) {
    Stop-Check "gh-clone: exit $($run.Exit)`n$($run.Out)"
}
$gitArgs = @([IO.File]::ReadAllLines($GitLog))
if (-not ($gitArgs -contains 'credential.https://github.com.helper=')) {
    Stop-Check "gh-clone: the clone did not reset the credential helper`n$($gitArgs -join "`n")"
}
$helperWant = 'credential.https://github.com.helper=!gh auth git-credential'
if (@($gitArgs | Where-Object { $_ -ieq $helperWant }).Count -eq 0) {
    Stop-Check "gh-clone: the clone did not carry gh's credential helper`n$($gitArgs -join "`n")"
}
if (-not ($gitArgs -contains 'clone')) {
    Stop-Check "gh-clone: git never cloned`n$($gitArgs -join "`n")"
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git'))) {
    Stop-Check 'gh-clone: the clone was not created'
}
$originNow = @(& git -C $InstallDir remote get-url origin 2>$null)
if ($originNow.Count -ne 1 -or $originNow[0] -ne $Origin) {
    Stop-Check "gh-clone: the clone's origin is $originNow"
}

# gh-not-signed-in: with gh signed out and no release URL, gh is asked once
# whether it is signed in and then serves nothing, and the clone carries no
# credential helper. A runtime install stops before the program download,
# whose plain HTTPS path would reach github.com; every other case runs that
# path over file://.
Reset-Bin
if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
Remove-Item -LiteralPath $GhLog, $GitLog -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($GhNotSignedIn, '')
try {
    $run = Invoke-Install -Settings @{
        SYNCSETTINGS_RELEASE_URL = ''
        SYNCSETTINGS_RUNTIME = 'node'
        SYNCSETTINGS_NO_SETUP = '1'
    } -PathPrefix @($GhStubDir, $GitStubDir)
} finally {
    Remove-Item -LiteralPath $GhNotSignedIn -Force -ErrorAction SilentlyContinue
}
if ($run.Exit -ne 0) {
    Stop-Check "gh-not-signed-in: exit $($run.Exit)`n$($run.Out)"
}
$ghArgs = @([IO.File]::ReadAllLines($GhLog))
if ($ghArgs.Count -ne 1 -or $ghArgs[0].Trim() -ne 'gh auth status') {
    Stop-Check "gh-not-signed-in: gh was asked for more than the sign-in`n$($ghArgs -join "`n")"
}
$gitArgs = @([IO.File]::ReadAllLines($GitLog))
if (@($gitArgs | Where-Object { $_.StartsWith('credential.https://github.com.helper') }).Count -gt 0) {
    Stop-Check "gh-not-signed-in: the clone carried a credential helper`n$($gitArgs -join "`n")"
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git'))) {
    Stop-Check 'gh-not-signed-in: the clone was not created'
}

Restore-Settings
Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'install-check: ok'
exit 0
