<#
.SYNOPSIS
    Front door for sync.cmd on Windows: status and doctor.
.DESCRIPTION
    Called by sync.cmd. Status shows where this machine stands and what to run
    next; doctor runs the Windows checks from docs/sync-contract.md. setup,
    pull and push print a placeholder until their steps land.
#>
param(
    [Parameter(Position = 0)][string]$Command,
    [switch]$Yes,
    [string]$Message = '',
    [switch]$NoFetch
)

$ErrorActionPreference = 'Stop'

$script:WindowsDir = $PSScriptRoot
$script:RepoRoot = Split-Path (Split-Path $script:WindowsDir -Parent) -Parent

# The OS name in the status line: SYNC_OS_NAME, else the Windows caption.
function Get-OsName {
    if ($env:SYNC_OS_NAME) {
        return $env:SYNC_OS_NAME
    }
    try {
        $caption = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).Caption
        if ($caption) {
            return ([string]$caption).Trim()
        }
    } catch {
    }
    return 'unknown'
}

# git as an executable, or $null when it is not installed.
function Get-GitCommand {
    return Get-Command git -CommandType Application -ErrorAction SilentlyContinue
}

# Run git in the repo without a terminal prompt. Returns its output and exit
# code; git writes to stderr, so a local Continue keeps that from throwing.
function Invoke-GitQuiet {
    param([string[]]$Arguments)
    $ErrorActionPreference = 'Continue'
    $env:GIT_TERMINAL_PROMPT = '0'
    $output = & git -C $script:RepoRoot @Arguments 2>$null
    return @{ Code = $LASTEXITCODE; Output = $output }
}

# Fetch origin master, giving up after 15 seconds. Returns $true on success.
function Invoke-GitFetch {
    $ErrorActionPreference = 'Continue'
    $env:GIT_TERMINAL_PROMPT = '0'
    $job = $null
    try {
        $job = Start-Job -ScriptBlock {
            param([string]$Root)
            $env:GIT_TERMINAL_PROMPT = '0'
            & git -C $Root fetch -q origin master 2>$null
            return $LASTEXITCODE
        } -ArgumentList $script:RepoRoot
        if (-not (Wait-Job -Job $job -Timeout 15)) {
            return $false
        }
        $result = @(Receive-Job -Job $job)
        return ($result.Count -gt 0 -and $result[-1] -eq 0)
    } catch {
        return $false
    } finally {
        if ($null -ne $job) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}

# Run the read-only import check in a child PowerShell, with stdin redirected,
# and read its exit code and summary line. Never writes and never prompts.
function Get-MachineInfo {
    $text = 'not checked: run sync.cmd import -Check to see why'
    $state = 'unknown'
    $checkScript = Join-Path $script:WindowsDir 'Import-Settings.ps1'
    $powershell = Get-Command powershell.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $powershell -or -not (Test-Path -LiteralPath $checkScript)) {
        return @{ Text = $text; State = $state }
    }
    $ErrorActionPreference = 'Continue'
    $output = '' | & $powershell.Source -NoProfile -ExecutionPolicy Bypass -File $checkScript -Check 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        $text = 'matches the repo'
        $state = 'match'
    } elseif ($code -eq 3) {
        $match = [regex]::Match($output, '(?m)^  ([0-9]+) file\(s\) would change\.')
        if ($match.Success) {
            $text = $match.Groups[1].Value + ' file(s) differ from the repo'
            $state = 'differ'
        }
    }
    return @{ Text = $text; State = $state }
}

# Print where this machine stands and the first command to run next.
function Show-Status {
    $isGit = $false
    $hasOrigin = $false
    $originText = ''
    $unsentText = ''
    $updates = 0
    $unsent = 0

    if ($null -ne (Get-GitCommand)) {
        $result = Invoke-GitQuiet @('rev-parse', '--is-inside-work-tree')
        if ($result.Code -eq 0) {
            $isGit = $true
        }
    }

    if (-not $isGit) {
        $originText = 'not a git clone'
        $unsentText = 'not checked'
    } else {
        $result = Invoke-GitQuiet @('remote', 'get-url', 'origin')
        if ($result.Code -ne 0) {
            $originText = 'no origin remote'
        } else {
            $hasOrigin = $true
            $branch = 'unknown'
            $branchResult = Invoke-GitQuiet @('rev-parse', '--abbrev-ref', 'HEAD')
            if ($branchResult.Code -eq 0 -and $null -ne $branchResult.Output) {
                $branch = ([string]@($branchResult.Output)[0]).Trim()
            }
            if ($branch -ne 'master') {
                $originText = 'on branch ' + $branch + ', not master'
            } elseif (-not (Invoke-GitFetch)) {
                $originText = 'offline, not checked'
            } else {
                $countResult = Invoke-GitQuiet @('rev-list', '--count', 'HEAD..origin/master')
                if ($countResult.Code -eq 0 -and $null -ne $countResult.Output) {
                    [void][int]::TryParse(([string]@($countResult.Output)[0]).Trim(), [ref]$updates)
                }
                if ($updates -gt 0) {
                    $originText = "$updates update(s) waiting"
                } else {
                    $originText = 'up to date'
                }
            }
        }

        $statusResult = Invoke-GitQuiet @('status', '--porcelain', '--untracked-files=all', '--', 'dotfiles', 'packages', 'sync-config.json')
        if ($statusResult.Code -eq 0 -and $null -ne $statusResult.Output) {
            $unsent = @($statusResult.Output | Where-Object { $null -ne $_ -and ([string]$_).Trim() -ne '' }).Count
        }
        if ($unsent -gt 0) {
            $unsentText = "$unsent changed file(s) not sent yet"
        } else {
            $unsentText = 'none'
        }
    }

    $machine = Get-MachineInfo

    if (-not $isGit -or -not $hasOrigin) {
        $next = 'run mksync doctor.'
    } elseif ($updates -gt 0) {
        $next = 'mksync pull'
    } elseif ($unsent -gt 0) {
        $next = 'mksync push'
    } elseif ($machine.State -eq 'differ') {
        $next = "mksync pull to take the repo's version, or mksync push to send this machine's."
    } else {
        $next = 'nothing to do.'
    }

    Write-Host ''
    Write-Host ('  SyncSettings  windows ({0})' -f (Get-OsName))
    Write-Host ('  {0,-10}: {1}' -f 'Repo', $script:RepoRoot)
    Write-Host ('  {0,-10}: {1}' -f 'Origin', $originText)
    Write-Host ('  {0,-10}: {1}' -f 'Unsent', $unsentText)
    Write-Host ('  {0,-10}: {1}' -f 'Machine', $machine.Text)
    Write-Host ''
    Write-Host ('  Next: {0}' -f $next)
}

function Write-Check {
    param([string]$Word, [string]$Text)
    Write-Host ('  {0,-8} {1}' -f $Word, $Text)
}

# One OK, WARN or MISSING line per check. Returns $false when a MISSING printed.
function Invoke-Doctor {
    $missing = 0
    $winget = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

    $version = $PSVersionTable.PSVersion
    if ($version.Major -gt 5 -or ($version.Major -eq 5 -and $version.Minor -ge 1)) {
        Write-Check 'OK' ('PowerShell ' + $version.ToString())
    } else {
        Write-Check 'MISSING' 'PowerShell 5.1 or newer'
        $missing = 1
    }

    if ($null -ne (Get-GitCommand)) {
        Write-Check 'OK' 'git'
    } else {
        if ($null -ne $winget) {
            Write-Check 'MISSING' 'git: install with winget install --id Git.Git -e'
        } else {
            Write-Check 'MISSING' 'git: install it from https://git-scm.com'
        }
        $missing = 1
    }

    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $gh) {
        if ($null -ne $winget) {
            Write-Check 'WARN' 'gh: needed for push; install with winget install --id GitHub.cli -e'
        } else {
            Write-Check 'WARN' 'gh: needed for push; see https://cli.github.com'
        }
    } else {
        $ErrorActionPreference = 'Continue'
        & $gh.Source auth status *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Check 'OK' 'gh (signed in)'
        } else {
            Write-Check 'WARN' 'gh: not signed in; run gh auth login'
        }
    }

    $hasOrigin = $false
    if ($null -ne (Get-GitCommand)) {
        $result = Invoke-GitQuiet @('remote', 'get-url', 'origin')
        if ($result.Code -eq 0) {
            $hasOrigin = $true
        }
    }
    if ($hasOrigin) {
        Write-Check 'OK' 'repo clone with origin'
    } else {
        Write-Check 'WARN' 'repo has no origin remote'
    }

    $launcherOk = $false
    $launcher = Get-Command mksync -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $launcher) {
        $launcherPath = $launcher.Source
        if (-not $launcherPath) {
            $launcherPath = $launcher.Path
        }
        if ($launcherPath -and $launcherPath -like '*mksync.cmd') {
            try {
                $text = [IO.File]::ReadAllText($launcherPath)
                $needle = Join-Path $script:RepoRoot 'sync.cmd'
                if ($text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $launcherOk = $true
                }
            } catch {
            }
        }
    }
    if ($launcherOk) {
        Write-Check 'OK' 'mksync on PATH'
    } else {
        Write-Check 'WARN' 'mksync not on PATH; run the installer again'
    }

    $count = 0
    $configPath = Join-Path $script:RepoRoot 'sync-config.json'
    $valuesPath = Join-Path $script:RepoRoot '.user-values.json'
    if (Test-Path -LiteralPath $configPath) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            $values = $null
            if (Test-Path -LiteralPath $valuesPath) {
                $values = Get-Content -LiteralPath $valuesPath -Raw | ConvertFrom-Json
            }
            $seen = @()
            foreach ($entry in @($config.files)) {
                if ($null -eq $entry) {
                    continue
                }
                if ($entry.platform -ne 'windows' -and $entry.platform -ne 'common') {
                    continue
                }
                foreach ($rule in @($entry.sanitizeRules)) {
                    if ($null -eq $rule) {
                        continue
                    }
                    $placeholder = [string]$rule.placeholder
                    if (-not $placeholder -or $seen -contains $placeholder) {
                        continue
                    }
                    $seen += $placeholder
                    if ([string]$rule.default -ne '' -or [string]$rule.defaultEnv -ne '') {
                        continue
                    }
                    $have = $false
                    if ($null -ne $values) {
                        $property = $values.PSObject.Properties[$placeholder]
                        if ($null -ne $property -and $null -ne $property.Value -and ([string]$property.Value).Length -gt 0) {
                            $have = $true
                        }
                    }
                    if (-not $have) {
                        $count++
                    }
                }
            }
        } catch {
            $count = 0
        }
    }
    if ($count -gt 0) {
        Write-Check 'WARN' "$count value(s) not set; mksync setup asks for them"
    } else {
        Write-Check 'OK' 'values'
    }

    if ($missing -gt 0) {
        Write-Host '  Fix the MISSING items, then run mksync doctor again.'
        return $false
    }
    Write-Host '  Ready.'
    return $true
}

if ([string]::IsNullOrEmpty($Command)) {
    $Command = 'status'
}

switch ($Command.ToLowerInvariant()) {
    'status' {
        Show-Status
        exit 0
    }
    'doctor' {
        if (Invoke-Doctor) {
            exit 0
        }
        exit 1
    }
    'setup' {
        Write-Host 'Not implemented yet.'
        exit 1
    }
    'pull' {
        Write-Host 'Not implemented yet.'
        exit 1
    }
    'push' {
        Write-Host 'Not implemented yet.'
        exit 1
    }
    default {
        [Console]::Error.WriteLine("Unknown command: $Command")
        exit 1
    }
}
