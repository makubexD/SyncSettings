<#
.SYNOPSIS
    Install SyncSettings on Windows: clone the repo (or update the clone),
    write the mksync launcher, then run setup.
.DESCRIPTION
    Runs as
    irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex
    so the whole script is one function, Install-SyncSettings, and its last
    line calls it: a cut-off download defines nothing and runs nothing.

    Under iex the script never calls `exit` (that would close the user's
    window); every failure is thrown and caught once at the top, which prints
    `ERROR: ...` and returns 1. When the script runs as a file (-File), the
    last line exits with the code Install-SyncSettings returns.

    Settings come from the environment, not parameters, since iex cannot pass
    any: SYNCSETTINGS_REPO_URL, SYNCSETTINGS_DIR, SYNCSETTINGS_REF,
    SYNCSETTINGS_BIN, SYNCSETTINGS_YES and SYNCSETTINGS_NO_SETUP.
#>

function Install-SyncSettings {
    $ErrorActionPreference = 'Stop'

    # A setting from the environment, or its default when unset or empty.
    function Get-Setting {
        param([string]$Name, [string]$Default)
        $value = [Environment]::GetEnvironmentVariable($Name)
        if ([string]::IsNullOrEmpty($value)) {
            return $Default
        }
        return $value
    }

    # The command for a tool, or $null when it is not installed.
    function Get-ToolCommand {
        param([string]$Name)
        return Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    # Run git without letting stderr throw; returns its exit code.
    function Invoke-Git {
        param([string[]]$Arguments)
        $ErrorActionPreference = 'Continue'
        & git @Arguments 2>$null | Out-Null
        return $LASTEXITCODE
    }

    # Run one winget install, discarding its (large) output.
    function Invoke-WingetInstall {
        param([string]$Id)
        $ErrorActionPreference = 'Continue'
        & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements *> $null
    }

    # True when the folder is a git clone with an origin remote.
    function Test-IsCloneWithOrigin {
        param([string]$Dir)
        if (-not (Test-Path -LiteralPath $Dir)) {
            return $false
        }
        if ((Invoke-Git @('-C', $Dir, 'rev-parse', '--show-toplevel')) -ne 0) {
            return $false
        }
        return ((Invoke-Git @('-C', $Dir, 'remote', 'get-url', 'origin')) -eq 0)
    }

    # True when the folder exists and holds at least one entry.
    function Test-DirNonEmpty {
        param([string]$Dir)
        if (-not (Test-Path -LiteralPath $Dir)) {
            return $false
        }
        return (@(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue).Count -gt 0)
    }

    # True when the folder is already an entry on the user Path.
    function Test-PathInUserPath {
        param([string]$Folder)
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ([string]::IsNullOrEmpty($userPath)) {
            return $false
        }
        $want = $Folder.Trim().TrimEnd('\')
        foreach ($entry in @($userPath -split ';')) {
            if (-not [string]::IsNullOrEmpty($entry) -and $entry.Trim().TrimEnd('\') -ieq $want) {
                return $true
            }
        }
        return $false
    }

    try {
        # 1. This installer is for Windows, and needs PowerShell 5.1.
        if ($env:OS -ne 'Windows_NT') {
            throw 'on Linux, run the bash installer from the README.'
        }
        if ($PSVersionTable.PSVersion -lt [version]'5.1') {
            throw 'SyncSettings needs PowerShell 5.1 or newer.'
        }

        $url = Get-Setting 'SYNCSETTINGS_REPO_URL' 'https://github.com/makubexD/SyncSettings.git'
        $dir = Get-Setting 'SYNCSETTINGS_DIR' (Join-Path $env:USERPROFILE 'SyncSettings')
        $ref = Get-Setting 'SYNCSETTINGS_REF' 'master'
        $bin = Get-Setting 'SYNCSETTINGS_BIN' (Join-Path $env:LOCALAPPDATA 'SyncSettings\bin')
        $yes = ($env:SYNCSETTINGS_YES -eq '1')
        $noSetup = ($env:SYNCSETTINGS_NO_SETUP -eq '1')

        # 2. Tools: git is required, gh only opens pull requests.
        $winget = Get-ToolCommand 'winget'
        $missing = @()
        if ($null -eq (Get-ToolCommand 'git')) {
            $missing += 'git'
        }
        if ($null -eq (Get-ToolCommand 'gh')) {
            $missing += 'gh'
        }

        if ($missing.Count -gt 0 -and $null -ne $winget) {
            $install = $yes
            if (-not $install) {
                $answer = Read-Host ('  Install ' + ($missing -join ' and ') + ' with winget? [Y/n]')
                $install = ([string]::IsNullOrEmpty($answer) -or ($answer -match '^y'))
            }
            if ($install) {
                foreach ($name in $missing) {
                    $id = 'GitHub.cli'
                    if ($name -eq 'git') {
                        $id = 'Git.Git'
                    }
                    # winget's own output is discarded, so say what is running:
                    # installing Git can take a minute or more.
                    Write-Host "  Installing $id with winget..."
                    Invoke-WingetInstall $id
                }
                $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
                $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
                $parts = @()
                if (-not [string]::IsNullOrEmpty($machinePath)) {
                    $parts += $machinePath
                }
                if (-not [string]::IsNullOrEmpty($userPath)) {
                    $parts += $userPath
                }
                $env:Path = $parts -join ';'
            }
        }

        if ($null -eq (Get-ToolCommand 'git')) {
            if ($null -ne $winget) {
                throw 'install Git, open a new window, and run this again.'
            }
            throw 'install Git from https://git-scm.com, open a new window, and run this again.'
        }

        if ($null -eq (Get-ToolCommand 'gh')) {
            Write-Host '  Note: gh is not installed; mksync push cannot open a pull request. Install it from https://cli.github.com.'
        }

        # 3. The repo clone: update one, or make a new one.
        if (Test-IsCloneWithOrigin $dir) {
            if ((Invoke-Git @('-C', $dir, 'pull', '--ff-only', '-q')) -ne 0) {
                throw "could not update $dir; resolve it and run this again."
            }
            Write-Host "  Updated $dir"
        } else {
            if (Test-DirNonEmpty $dir) {
                throw "$dir exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR."
            }
            if ((Invoke-Git @('clone', '-q', '--branch', $ref, $url, $dir)) -ne 0) {
                throw "could not clone $url."
            }
            Write-Host "  Cloned into $dir"
        }

        if (-not (Test-Path -LiteralPath (Join-Path $dir 'sync.cmd')) -or
            -not (Test-Path -LiteralPath (Join-Path $dir 'sync-config.json'))) {
            throw "$dir doesn't look like SyncSettings."
        }

        # 4. The mksync launcher in the bin folder.
        $launcher = Join-Path $bin 'mksync.cmd'
        if (Test-Path -LiteralPath $launcher) {
            $isOurs = $false
            try {
                $lines = [IO.File]::ReadAllLines($launcher)
                if ($lines.Count -ge 2 -and $lines[0].Trim() -eq '@echo off' -and
                    $lines[1].Trim() -eq 'rem SyncSettings launcher') {
                    $isOurs = $true
                }
            } catch {
                $isOurs = $false
            }
            if (-not $isOurs) {
                throw "$launcher already exists; remove it and run this again."
            }
        } else {
            $null = New-Item -ItemType Directory -Path $bin -Force
        }

        $content = "@echo off`r`n" +
            "rem SyncSettings launcher`r`n" +
            "call `"$dir\sync.cmd`" %*`r`n" +
            "exit /b %ERRORLEVEL%`r`n"
        [IO.File]::WriteAllText($launcher, $content, [Text.Encoding]::ASCII)

        if (-not (Test-PathInUserPath $bin)) {
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $newUserPath = $bin
            if (-not [string]::IsNullOrEmpty($userPath)) {
                $newUserPath = $userPath.TrimEnd(';') + ';' + $bin
            }
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            if ([string]::IsNullOrEmpty($env:Path)) {
                $env:Path = $bin
            } else {
                $env:Path = $env:Path.TrimEnd(';') + ';' + $bin
            }
            Write-Host "  Added $bin to your PATH. New windows will find mksync."
        }

        # 5. Setup, unless the caller skipped it.
        if (-not $noSetup) {
            $setupArgs = @('setup')
            if ($yes) {
                $setupArgs += '-Yes'
            }
            # Out-Host streams setup's output (and its prompts) as it runs, and
            # keeps it out of this function's return value.
            & (Join-Path $dir 'sync.cmd') @setupArgs | Out-Host
            $setupCode = $LASTEXITCODE
            if ($setupCode -ne 0) {
                throw 'setup failed; run mksync setup to see why.'
            }
        }

        # 6. Done.
        Write-Host '  Installed. Run mksync any time.'
        return 0
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        return 1
    }
}

if ($PSCommandPath) { exit (Install-SyncSettings) } else { $null = Install-SyncSettings }
