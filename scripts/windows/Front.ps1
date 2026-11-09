<#
.SYNOPSIS
    Front door for sync.cmd on Windows: status, doctor, setup, pull and push.
.DESCRIPTION
    Called by sync.cmd. Status shows where this machine stands and what to run
    next; doctor runs the Windows checks from docs/sync-contract.md; setup is
    the first run on this machine; pull gets the latest repo and applies it;
    push sends this machine's changes as a PR.
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

# The Windows PowerShell to run a child step with. Front.ps1 itself runs under
# it, so the command is always there.
$script:PowerShellExe = Get-Command powershell.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

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
    return Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
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
    # A plain child process with a 15-second wait: background jobs in Windows
    # PowerShell 5.1 start slowly and lose the exit code. Output is discarded
    # (the fetch is quiet), so nothing reaches the caller's stderr.
    $git = Get-GitCommand
    if ($null -eq $git) {
        return $false
    }
    $process = $null
    try {
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $git.Source
        $info.Arguments = '-C "' + $script:RepoRoot + '" fetch -q origin master'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
        $process = [System.Diagnostics.Process]::Start($info)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch { }
            return $false
        }
        [void]$stdout.Wait(1000)
        [void]$stderr.Wait(1000)
        return ($process.ExitCode -eq 0)
    } catch {
        return $false
    } finally {
        if ($null -ne $process) {
            $process.Dispose()
        }
    }
}

# Lines git reports as changed among the sync paths.
function Get-SyncChanges {
    $result = Invoke-GitQuiet @('status', '--porcelain', '--', 'dotfiles', 'packages', 'sync-config.json')
    if ($result.Code -ne 0 -or $null -eq $result.Output) {
        return @()
    }
    return @($result.Output | Where-Object { $null -ne $_ -and ([string]$_).Trim() -ne '' })
}

# Stop unless this clone is on master with an origin remote, which pull and
# push both need.
function Assert-CloneReady {
    param([string]$Name)
    $ready = $false
    if ($null -ne (Get-GitCommand)) {
        $inside = Invoke-GitQuiet @('rev-parse', '--is-inside-work-tree')
        if ($inside.Code -eq 0) {
            $origin = Invoke-GitQuiet @('remote', 'get-url', 'origin')
            if ($origin.Code -eq 0) {
                $branch = Invoke-GitQuiet @('rev-parse', '--abbrev-ref', 'HEAD')
                if ($branch.Code -eq 0 -and $null -ne $branch.Output) {
                    if (([string]@($branch.Output)[0]).Trim() -eq 'master') {
                        $ready = $true
                    }
                }
            }
        }
    }
    if (-not $ready) {
        Write-Host "ERROR: $Name needs the repo clone on master with an origin remote."
        exit 1
    }
}

# Ask a [Y/n] question: Read-Host at a terminal, else one line from the
# redirected stdin. An empty answer or end of input means yes.
function Read-Answer {
    param([string]$Prompt)
    if ([Console]::IsInputRedirected) {
        Write-Host $Prompt -NoNewline
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) {
            return ''
        }
        return $line
    }
    return Read-Host $Prompt
}

# Run the read-only import check in a child PowerShell, with stdin redirected,
# show its output, and return its exit code.
function Invoke-ImportCheck {
    $checkScript = Join-Path $script:WindowsDir 'Import-Settings.ps1'
    $ErrorActionPreference = 'Continue'
    $output = '' | & $script:PowerShellExe.Source -NoProfile -ExecutionPolicy Bypass -File $checkScript -Check 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $output
    return $code
}

# First run on this machine: doctor, then the import check and, unless
# declined, the import. There is no bootstrap question on Windows.
function Invoke-Setup {
    if (-not (Invoke-Doctor)) {
        exit 1
    }

    $ErrorActionPreference = 'Continue'
    $code = Invoke-ImportCheck
    if ($code -ne 0 -and $code -ne 3) {
        exit 1
    }

    $apply = $true
    if ($code -eq 3) {
        if (-not $Yes) {
            $answer = Read-Answer '  Apply these changes? [Y/n]'
            if (-not [string]::IsNullOrEmpty($answer) -and $answer -notmatch '^y') {
                Write-Host '  Nothing applied.'
                $apply = $false
            }
        }
        if ($apply) {
            & $script:PowerShellExe.Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:WindowsDir 'Import-Settings.ps1') -Force
            $importCode = $LASTEXITCODE
            if ($importCode -ne 0) {
                exit $importCode
            }
        }
    }

    Write-Host '  Setup done. Run mksync any time to see where this machine stands.'
    exit 0
}

# Get the latest repo and apply it here: fetch, fast-forward, rerun this to run
# the new code, then the import check and, unless declined, the import.
function Invoke-Pull {
    Assert-CloneReady 'pull'

    if (@(Get-SyncChanges).Count -gt 0) {
        Write-Host 'ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.'
        exit 1
    }

    if (-not $NoFetch) {
        if (-not (Invoke-GitFetch)) {
            Write-Host 'ERROR: could not reach origin.'
            exit 1
        }
        $updates = 0
        $countResult = Invoke-GitQuiet @('rev-list', '--count', 'HEAD..origin/master')
        if ($countResult.Code -eq 0 -and $null -ne $countResult.Output) {
            [void][int]::TryParse(([string]@($countResult.Output)[0]).Trim(), [ref]$updates)
        }
        if ($updates -gt 0) {
            $pullResult = Invoke-GitQuiet @('pull', '--ff-only', '-q')
            if ($pullResult.Code -ne 0) {
                Write-Host 'ERROR: pull failed; resolve it and rerun.'
                exit 1
            }
            Write-Host ('  Pulled {0} commit(s).' -f $updates)
            # Run the just-pulled code, not the copy this process started with.
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:WindowsDir 'Front.ps1'), 'pull', '-NoFetch')
            if ($Yes) {
                $arguments += '-Yes'
            }
            & $script:PowerShellExe.Source @arguments
            exit $LASTEXITCODE
        }
    }

    $ErrorActionPreference = 'Continue'
    $code = Invoke-ImportCheck

    if ($code -eq 0) {
        exit 0
    }
    if ($code -ne 3) {
        exit 1
    }

    if (-not $Yes) {
        $answer = Read-Answer '  Apply these changes? [Y/n]'
        if (-not [string]::IsNullOrEmpty($answer) -and $answer -notmatch '^y') {
            Write-Host '  Nothing applied.'
            exit 0
        }
    }

    & $script:PowerShellExe.Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:WindowsDir 'Import-Settings.ps1') -Force
    exit $LASTEXITCODE
}

# Send this machine's changes as a PR: export, show the diff and, unless
# declined, run the commit flow.
function Invoke-Push {
    Assert-CloneReady 'push'

    # Stdin stays attached so the export can ask for missing values.
    & $script:PowerShellExe.Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:WindowsDir 'Export-Settings.ps1')
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        exit $code
    }

    if (@(Get-SyncChanges).Count -eq 0) {
        Write-Host '  Nothing to send: the repo matches this machine.'
        exit 0
    }

    $statusResult = Invoke-GitQuiet @('status', '--short', '--', 'dotfiles', 'packages', 'sync-config.json')
    foreach ($line in @($statusResult.Output)) {
        if ($null -ne $line) {
            Write-Host $line
        }
    }

    if (-not $Yes) {
        $answer = Read-Answer '  Open a PR with these changes? [Y/n]'
        if (-not [string]::IsNullOrEmpty($answer) -and $answer -notmatch '^y') {
            Write-Host '  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.'
            exit 0
        }
    }

    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:WindowsDir 'Commit-Settings.ps1'))
    if ($Message) {
        $arguments += @('-Message', $Message)
    }
    & $script:PowerShellExe.Source @arguments
    exit $LASTEXITCODE
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
                # Same selection as Test-WindowsEntry in SyncHelpers.ps1, which this
                # file doesn't load. Never compare a list with -ne: that filters.
                $platform = $entry.platform
                if ($platform -is [array]) {
                    if (-not ($platform -ccontains 'windows')) {
                        continue
                    }
                } elseif ($platform -cne 'windows' -and $platform -cne 'common') {
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
        Invoke-Setup
    }
    'pull' {
        Invoke-Pull
    }
    'push' {
        Invoke-Push
    }
    default {
        [Console]::Error.WriteLine("Unknown command: $Command")
        exit 1
    }
}
