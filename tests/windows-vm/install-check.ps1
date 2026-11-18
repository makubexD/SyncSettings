<#
.SYNOPSIS
    Checks install.ps1 in the Windows VM: a folder release served over file://,
    a bare origin built from this copy of the working tree, and a fake program
    that logs its arguments. Prints `install-check: ok` and exits 0, or the
    failed check and exits 1.
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
function Invoke-Install {
    param([hashtable]$Settings = @{})
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
    try {
        $script:InstallOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'install.ps1') 2>&1 | Out-String
        $script:InstallExit = $LASTEXITCODE
    } finally {
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

Restore-Settings
Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'install-check: ok'
exit 0
