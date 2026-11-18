# The cut-over check for a Windows work machine (docs/windows-cutover-run.md).
#
# Run it in Windows PowerShell 5.1:
#   irm https://raw.githubusercontent.com/makubexD/SyncSettings/engine/cutover/tools/windows-cutover-check.ps1 | iex
#
# It checks what it needs first and stops with a fix when something is
# missing. Then it installs mksync from the clone with Node (no download of a
# program), runs read-only commands, and writes a redacted report to
# Downloads\mksync-check.txt (also copied to the clipboard). It never runs
# mksync pull, push, setup or export. Under iex it never calls `exit`, which
# would close the window.

function Invoke-CutoverCheck {
    $ErrorActionPreference = 'Continue'
    # mksync prints UTF-8 (the statusline bar); read it as such, then put the
    # console back as it was.
    $oldEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    try {
        Invoke-CheckBody
    } finally {
        [Console]::OutputEncoding = $oldEncoding
    }
}

function Invoke-CheckBody {
    $report = New-Object System.Collections.Generic.List[string]
    $script:failed = $false

    $dir = $env:SYNCSETTINGS_DIR
    if ([string]::IsNullOrEmpty($dir)) {
        $dir = Join-Path $env:USERPROFILE 'SyncSettings'
    }
    $bin = Join-Path $env:LOCALAPPDATA 'mksync'
    $shim = Join-Path $bin 'mksync.cmd'
    $installUrl = 'https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1'

    # Names that never leave the machine: longest first, so the home folder
    # goes before the user name inside it.
    $secrets = @()
    foreach ($pair in @(
            @($env:USERPROFILE, 'C:\Users\USER'),
            @($env:USERDNSDOMAIN, 'DOMAIN'),
            @($env:USERDOMAIN, 'DOMAIN'),
            @($env:COMPUTERNAME, 'HOST'),
            @($env:USERNAME, 'USER'))) {
        if (-not [string]::IsNullOrEmpty($pair[0]) -and $pair[0].Length -ge 3) {
            $secrets += , $pair
        }
    }

    function Hide([string]$text) {
        if ($null -eq $text) { return '' }
        $t = $text -replace "\x1b\[[0-9;]*m", ''
        foreach ($pair in $secrets) {
            $t = $t -replace [regex]::Escape($pair[0]), $pair[1]
            $t = $t -replace [regex]::Escape($pair[0].Replace('\', '/')), $pair[1].Replace('\', '/')
        }
        $t = $t -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>'
        return $t
    }

    function Say([string]$text) {
        Write-Host $text
        $report.Add((Hide $text))
    }

    function Stop-Check([string]$why, [string]$fix) {
        Write-Host ''
        Write-Host "STOP: $why" -ForegroundColor Red
        Write-Host "Fix:  $fix" -ForegroundColor Yellow
        Write-Host 'Then run the same irm line again.'
        $script:failed = $true
    }

    # Runs a command, prints and records each output line, returns the exit code.
    function Run([string]$label, [scriptblock]$block) {
        Say "> $label"
        $lines = @(& $block 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        foreach ($line in $lines) { Say "  $line" }
        Say "  exit: $code"
        return $code
    }

    Write-Host ''
    Write-Host 'SyncSettings cut-over check' -ForegroundColor Cyan
    Write-Host ''

    # ---- 0. What the check needs --------------------------------------------
    Say '## 0 before'
    Say "powershell: $($PSVersionTable.PSVersion)"
    if ($PSVersionTable.PSVersion -lt [version]'5.1') {
        Stop-Check 'PowerShell 5.1 or newer is needed.' 'open "Windows PowerShell" from the Start menu, not an older shell.'
        return
    }
    Say "language mode: $($ExecutionContext.SessionState.LanguageMode)"

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        Stop-Check 'git is not on PATH.' 'install Git for Windows, or open a new PowerShell window if you just installed it.'
        return
    }
    Say "git: $(git --version)"

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        Stop-Check 'node is not on PATH.' 'Node 22.18 or newer must be installed; open a new window if it is.'
        return
    }
    $nodeVersion = "$(node -p 'process.versions.node' 2>$null)".Trim()
    Say "node: $nodeVersion"
    $nv = $nodeVersion.Split('.')
    if ($nv.Count -lt 2 -or [int]$nv[0] -lt 22 -or ([int]$nv[0] -eq 22 -and [int]$nv[1] -lt 18)) {
        Stop-Check "Node $nodeVersion is older than 22.18." 'update Node, or tell the cut-over session which version you have.'
        return
    }

    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        Stop-Check "the clone is not at $(Hide $dir)." ('clone it: git clone https://github.com/makubexD/SyncSettings.git "' + $dir + '"')
        return
    }
    $top = "$(git -C $dir rev-parse --show-toplevel 2>$null)".Trim()
    if ([string]::IsNullOrEmpty($top)) {
        Stop-Check "$(Hide $dir) is not a git clone." 'rename that folder, then clone it again (see the run sheet).'
        return
    }
    $origin = "$(git -C $dir remote get-url origin 2>$null)".Trim()
    if ($origin -notmatch 'makubexD/SyncSettings') {
        Stop-Check "the clone's origin is not makubexD/SyncSettings." 'tell the cut-over session what `git -C "%USERPROFILE%\SyncSettings" remote -v` shows.'
        return
    }
    $branch = "$(git -C $dir branch --show-current 2>$null)".Trim()
    $dirty = @(git -C $dir status --porcelain 2>$null | Where-Object { $_ -notmatch '^\?\? ' }).Count
    Say "clone: yes, branch $branch, changed tracked files: $dirty"
    if ($branch -ne 'master') {
        Stop-Check "the clone is on branch '$branch', not master." ('git -C "' + $dir + '" switch master')
        return
    }
    if ($dirty -gt 0) {
        Stop-Check "the clone has $dirty changed file(s); the installer's git pull may refuse." ('look at them with: git -C "' + $dir + '" status    (commit or stash them, or ask the cut-over session)')
        return
    }

    if (Test-Path -LiteralPath (Join-Path $bin 'mksync.exe')) {
        Stop-Check "$(Hide $bin)\mksync.exe exists; the Node install won't replace a program." ('Remove-Item "' + (Join-Path $bin 'mksync.exe') + '"')
        return
    }
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $gh) {
        Say 'gh: not installed'
        Write-Host ''
        Write-Host 'NOTE: the installer will ask "Install gh with winget? [Y/n]".' -ForegroundColor Yellow
        Write-Host '      Type n and press Enter. Nothing gets installed; gh only opens pull requests.' -ForegroundColor Yellow
        Write-Host ''
    } else {
        Say 'gh: installed'
    }

    # ---- 1. Install from the clone ------------------------------------------
    Say ''
    Say '## 1 install'
    $env:SYNCSETTINGS_RUNTIME = 'node'
    $env:SYNCSETTINGS_NO_SETUP = '1'
    # The installer runs in this window, as `irm … | iex` would: it never calls
    # exit, and its one question (install a missing gh?) reaches the user.
    Say '> installer (Node, no setup)'
    try {
        $installer = Invoke-RestMethod -Uri $installUrl -UseBasicParsing
        Invoke-Expression $installer
        Say '  installer: finished'
    } catch {
        Say "  installer: failed: $($_.Exception.Message)"
    } finally {
        Remove-Item Env:SYNCSETTINGS_RUNTIME, Env:SYNCSETTINGS_NO_SETUP -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $shim)) {
        Stop-Check 'the installer did not create mksync.cmd.' 'paste this whole window into the cut-over session.'
        return
    }
    # This window doesn't see the new user Path yet: add the folder for this run.
    $env:Path = "$bin;$env:Path"
    $null = Run 'mksync --version' { mksync --version }

    # ---- 2. Install location ------------------------------------------------
    Say ''
    Say '## 2 location'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = @($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -gt 0
    Say "mksync.cmd in %LOCALAPPDATA%\mksync: $(Test-Path -LiteralPath $shim)"
    Say "no mksync.exe there: $(-not (Test-Path -LiteralPath (Join-Path $bin 'mksync.exe')))"
    Say "%LOCALAPPDATA%\mksync on the user Path: $onPath"
    Say "old launcher %LOCALAPPDATA%\SyncSettings\bin\mksync.cmd gone: $(-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'SyncSettings\bin\mksync.cmd')))"

    # ---- 3. Git Bash (the shell Claude Code uses for hooks and statusLine) --
    Say ''
    Say '## 3 git bash'
    $bash = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
    if (Test-Path -LiteralPath $bash) {
        Say "bash.exe: found next to git"
        # No double quotes inside: PowerShell 5.1 drops them on the way to bash.
        $null = Run 'bash: $HOME, and ~ as a Windows path' { & $bash -c 'echo HOME=$HOME; cd ~; pwd -W' }
        $null = Run 'bash: mksync --version' { & $bash -c 'mksync --version' }
        $null = Run 'bash: mksync.cmd --version' { & $bash -c 'mksync.cmd --version' }
    } else {
        Say 'bash.exe: not found next to git'
    }

    # ---- 4. Home in PowerShell ----------------------------------------------
    Say ''
    Say '## 4 home'
    Say "PowerShell ~ : $((Resolve-Path ~).Path)"
    Say "PowerShell `$HOME : $HOME"
    Say "jq: $(if (Get-Command jq -ErrorAction SilentlyContinue) { jq --version } else { 'not on PATH' })"

    # ---- 5. Statusline by hand ----------------------------------------------
    Say ''
    Say '## 5 statusline'
    $payload = Join-Path $dir 'tools\statusline-payloads\full.json'
    if (Test-Path -LiteralPath $payload) {
        $json = [IO.File]::ReadAllText($payload)
        $null = Run 'sample payload | mksync statusline' { $json | mksync statusline }
    } else {
        Say 'payload file missing in the clone'
    }

    # ---- 6. Local state -----------------------------------------------------
    Say ''
    Say '## 6 local state'
    $values = Join-Path $dir '.user-values.json'
    if (Test-Path -LiteralPath $values) {
        $null = Run 'icacls .user-values.json' { icacls $values }
    } else {
        Say '.user-values.json: does not exist'
    }

    # ---- 7. Read-only mksync commands, in the clone -------------------------
    Say ''
    Say '## 7 status'
    Push-Location -LiteralPath $dir
    try {
        $null = Run 'mksync status' { mksync status }
        $null = Run 'mksync doctor' { mksync doctor }
        $null = Run 'mksync check' { mksync check }
        Say ''
        Say '## 8 shadow'
        $null = Run 'mksync shadow' { mksync shadow }
        Say ''
        Say '## 9 update'
        $null = Run 'mksync update' { mksync update }
        Say ''
        Say '## 10 bun'
        if (Get-Command bun -ErrorAction SilentlyContinue) {
            Say "bun: $(bun --version)"
            $env:MKSYNC_RUNTIME = 'bun'
            try {
                $null = Run 'MKSYNC_RUNTIME=bun mksync.cmd --version' { & (Join-Path $dir 'mksync.cmd') --version }
            } finally {
                Remove-Item Env:MKSYNC_RUNTIME -ErrorAction SilentlyContinue
            }
        } else {
            Say 'bun: not installed'
        }
    } finally {
        Pop-Location
    }

    # ---- The report ---------------------------------------------------------
    $outDir = Join-Path $env:USERPROFILE 'Downloads'
    if (-not (Test-Path -LiteralPath $outDir -PathType Container)) {
        $outDir = $env:USERPROFILE
    }
    $out = Join-Path $outDir 'mksync-check.txt'
    [IO.File]::WriteAllText($out, (($report -join "`r`n") + "`r`n"))
    $copied = $false
    try {
        Set-Clipboard -Value ($report -join "`r`n")
        $copied = $true
    } catch {
        $copied = $false
    }
    Write-Host ''
    Write-Host 'Done.' -ForegroundColor Green
    Write-Host "Report: $out"
    if ($copied) {
        Write-Host 'It is also on the clipboard.'
    }
    Write-Host 'Read it, replace any company or host name with work-tool-1, then paste it into the cut-over session.'
}

Invoke-CutoverCheck
