<#
.SYNOPSIS
    Checks in the Windows VM that the program finds commands on PATH only and
    that the statusline shows a Windows directory's last part. Prints
    `lookup-check: ok` and exits 0, or the failed check and exits 1.
.DESCRIPTION
    Run from the repo copy in the VM, after dist/mksync.exe is built:
        powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-vm/lookup-check.ps1 [-Engine <exe>]

    Work #1 (2026-11-26) found that a whoami.exe copied into the clone as
    git.exe ran in place of git (`Origin : not a git clone`). This makes a
    throwaway clone with a local bare origin, runs `mksync status` in it, then
    plants the same git.exe and runs it again: the two outputs must match and
    neither may say `not a git clone`. Work #2 (2026-11-26) found the doctor
    warning about bash with Git's cmd folder alone on PATH, and missing
    winget's app execution alias: `mksync doctor` must read `OK bash` with the
    VM's PATH, and name the winget install with only System32 and
    WindowsApps on PATH. HOME and USERPROFILE point at a
    throwaway folder, so nothing outside it is read or written.
#>
param(
    [string]$Engine = 'dist/mksync.exe'
)

$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Exe = (Resolve-Path (Join-Path $Repo $Engine)).Path
$T = Join-Path $env:TEMP ('lookup-check-' + [Guid]::NewGuid().ToString('N'))
$Home2 = Join-Path $T 'home'
$Origin = Join-Path $T 'origin.git'
$Clone = Join-Path $T 'parity-clone'
$null = New-Item -ItemType Directory -Path $Home2 -Force
$null = New-Item -ItemType Directory -Path $Clone -Force

$SavedHome = $env:HOME
$SavedProfile = $env:USERPROFILE

function Stop-Check([string]$Message) {
    $env:HOME = $SavedHome
    $env:USERPROFILE = $SavedProfile
    Write-Output "lookup-check: FAIL $Message"
    exit 1
}

# PowerShell 5.1 turns a native command's stderr into an error record under
# Stop, so git's warnings would end the check: run it under Continue.
function Invoke-Git([string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $output = & git -c core.autocrlf=false @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        Stop-Check ("git " + ($Arguments -join ' ') + ": " + ($output -join ' '))
    }
}

function Invoke-Status {
    $ErrorActionPreference = 'Continue'
    Push-Location $Clone
    try {
        $lines = & $Exe status 2>&1 | ForEach-Object { "$_" }
    } finally {
        Pop-Location
    }
    return ($lines -join "`n")
}

$env:HOME = $Home2
$env:USERPROFILE = $Home2
$env:GIT_CONFIG_GLOBAL = Join-Path $Home2 'gitconfig'
[IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL, "[user]`n`tname = Parity`n`temail = parity@example.com`n")

Invoke-Git @('init', '-q', '--bare', $Origin)
Invoke-Git @('-C', $Clone, 'init', '-q', '-b', 'master')
Copy-Item -LiteralPath (Join-Path $Repo 'sync-config.json') -Destination (Join-Path $Clone 'sync-config.json')
Invoke-Git @('-C', $Clone, 'add', 'sync-config.json')
Invoke-Git @('-C', $Clone, 'commit', '-q', '-m', 'parity')
Invoke-Git @('-C', $Clone, 'remote', 'add', 'origin', $Origin)
Invoke-Git @('-C', $Clone, 'push', '-q', 'origin', 'master')

# 1. The baseline: real git only.
$before = Invoke-Status
if ($before -notmatch 'Origin') {
    Stop-Check "status without a planted git.exe has no Origin line:`n$before"
}
if ($before -match 'not a git clone') {
    Stop-Check "status without a planted git.exe says not a git clone:`n$before"
}

# 2. A whoami.exe planted in the clone as git.exe must not run.
$whoami = Join-Path $env:SystemRoot 'System32\whoami.exe'
Copy-Item -LiteralPath $whoami -Destination (Join-Path $Clone 'git.exe')
$after = Invoke-Status
if ($after -match 'not a git clone') {
    Stop-Check "the git.exe in the clone ran in place of git:`n$after"
}
if ($after -ne $before) {
    Stop-Check "status changed once git.exe was in the clone:`n--- before`n$before`n--- after`n$after"
}

# 3. The statusline shows a Windows cwd's last part.
$env:SYNC_GIT = 'none'
$payload = '{"model":{"display_name":"Claude Example"},"cwd":' + (ConvertTo-Json ($Clone + '\')) + '}'
$ErrorActionPreference = 'Continue'
$line = ($payload | & $Exe statusline 2>&1 | ForEach-Object { "$_" }) -join "`n"
Remove-Item Env:SYNC_GIT
if ($line -notmatch 'parity-clone') {
    Stop-Check "statusline has no directory section: $line"
}
if ($line.Contains($T)) {
    Stop-Check "statusline printed the whole directory: $line"
}

# mksync doctor in the clone, with PATH as given (the caller's when empty).
function Invoke-Doctor([string]$Path) {
    $ErrorActionPreference = 'Continue'
    $savedPath = $env:PATH
    if ($Path) {
        $env:PATH = $Path
    }
    Push-Location $Clone
    try {
        $lines = & $Exe doctor 2>&1 | ForEach-Object { "$_" }
    } finally {
        Pop-Location
        $env:PATH = $savedPath
    }
    return ($lines -join "`n")
}

# 4. The doctor finds Git Bash from git, as the leak scan does: the VM's PATH
#    has Git's cmd folder only, as work #2's has (2026-11-26).
$doctor = Invoke-Doctor ''
if ($doctor -notmatch '(?m)^\s*OK\s+bash\s*$') {
    Stop-Check "doctor misses the Git Bash found from git:`n$doctor"
}

# 5. The doctor finds winget's app execution alias: with no git on PATH, the
#    bash line names the winget install, not git-scm.com.
$apps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
if (Test-Path -LiteralPath (Join-Path $apps 'winget.exe')) {
    $doctor = Invoke-Doctor ((Join-Path $env:SystemRoot 'System32') + ';' + $apps)
    if ($doctor -notmatch 'install with winget install --id Git\.Git -e' -or $doctor -match 'git-scm\.com') {
        Stop-Check "doctor misses winget's app execution alias:`n$doctor"
    }
} else {
    Write-Output 'lookup-check: no winget in this VM, check 5 skipped'
}

$env:HOME = $SavedHome
$env:USERPROFILE = $SavedProfile
Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'lookup-check: ok'
exit 0
