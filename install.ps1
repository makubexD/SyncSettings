<#
.SYNOPSIS
    Install SyncSettings on Windows: clone the repo (or update the clone),
    install the mksync program, then run setup.
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
    SYNCSETTINGS_BIN, SYNCSETTINGS_YES, SYNCSETTINGS_NO_SETUP,
    SYNCSETTINGS_RELEASE_URL, SYNCSETTINGS_RUNTIME and SYNC_ARCH (which
    overrides PROCESSOR_ARCHITECTURE).
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

    # Run gh without letting its output throw; returns its exit code.
    function Invoke-Gh {
        param([string[]]$Arguments)
        $ErrorActionPreference = 'Continue'
        & gh @Arguments *> $null
        return $LASTEXITCODE
    }

    # Run git and return its output, trimmed, or '' when it fails.
    function Get-GitOutput {
        param([string[]]$Arguments)
        $ErrorActionPreference = 'Continue'
        $text = (& git @Arguments 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return ''
        }
        return $text
    }

    # True when the URL is a github.com remote: the only one gh's credential
    # helper is for.
    function Test-GitHubUrl {
        param([string]$Url)
        return ($Url -like 'https://github.com/*' -or $Url -like 'git@github.com:*' -or
            $Url -like 'ssh://git@github.com/*')
    }

    # The two -c options that give gh's credential helper to one git command
    # only, so nothing is written to ~/.gitconfig. gh is on PATH here, so the
    # helper names it bare: a quoted path would need escaping that differs
    # between Windows PowerShell 5.1 and PowerShell 7.3+.
    function Get-GhGitOptions {
        return @(
            '-c', 'credential.https://github.com.helper=',
            '-c', 'credential.https://github.com.helper=!gh auth git-credential'
        )
    }

    # The empty-string argument for a native command: Windows PowerShell 5.1
    # (and 7.0-7.2) drop a real empty string, so it passes a quoted pair that
    # the program's argument parser reads back as empty.
    function Get-EmptyNativeArgument {
        $mode = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue
        if ($null -ne $mode -and "$mode" -ne 'Legacy') {
            return ''
        }
        return '""'
    }

    # Writes the clone's own git login for github.com, into its .git/config
    # only: the repo owner's account, for a machine with several accounts in
    # gh. The owner is the one in the origin URL as configured; nothing is
    # written without a valid owner name or a token gh gives for that owner.
    # The token is discarded here: git asks gh for it each time.
    function Set-CloneGitLogin {
        param([string]$Dir)
        $origin = Get-GitOutput @('-C', $Dir, 'config', '--get', 'remote.origin.url')
        # Case-sensitive, like install.sh: Test-GitHubUrl ignores case, so it is
        # not the gate here.
        $owner = ''
        if ($origin -cmatch '^(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)([^/]+)') {
            $owner = $Matches[1]
        }
        if (-not ($owner -cmatch '^[A-Za-z0-9-]{1,39}$')) {
            return
        }
        $ErrorActionPreference = 'Continue'
        $token = (& gh auth token --hostname github.com --user $owner 2>$null | Out-String).Trim()
        $tokenExit = $LASTEXITCODE
        if ($tokenExit -ne 0 -or $token -eq '') {
            return
        }
        $token = $null
        $key = 'credential.https://github.com.helper'
        $helper = '!f() { test $1 = get || return 0; t=$(gh auth token --hostname github.com --user ' + $owner +
            ') && test -n $t && echo username=' + $owner + ' && echo password=$t; }; f'
        $emptied = Invoke-Git @('-C', $Dir, 'config', '--local', '--replace-all', $key, (Get-EmptyNativeArgument))
        $added = 1
        if ($emptied -eq 0) {
            $added = Invoke-Git @('-C', $Dir, 'config', '--local', '--add', $key, $helper)
        }
        if ($emptied -ne 0 -or $added -ne 0) {
            if ($emptied -eq 0) {
                # Undo a half write: the empty value alone leaves git no helper.
                Invoke-Git @('-C', $Dir, 'config', '--local', '--unset-all', $key) | Out-Null
            }
            Write-Warning "could not write git's GitHub login into $Dir."
            return
        }
        Write-Host "  Git signs in to github.com as $owner in $Dir"
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

    # True when the file is a launcher this installer wrote: its first two
    # lines are the marker.
    function Test-OursCmd {
        param([string]$Path)
        try {
            $lines = [IO.File]::ReadAllLines($Path)
            return ($lines.Count -ge 2 -and $lines[0].Trim() -eq '@echo off' -and
                $lines[1].Trim() -eq 'rem SyncSettings launcher')
        } catch {
            return $false
        }
    }

    # True when the file is a launcher this installer wrote: its second line
    # is the marker.
    function Test-OursSh {
        param([string]$Path)
        try {
            $lines = [IO.File]::ReadAllLines($Path)
            return ($lines.Count -ge 2 -and $lines[1] -eq '# SyncSettings launcher')
        } catch {
            return $false
        }
    }

    # True when the two files hold the same bytes.
    function Test-SameFile {
        param([string]$Path1, [string]$Path2)
        $first = Get-FileHash -LiteralPath $Path1 -Algorithm SHA256
        $second = Get-FileHash -LiteralPath $Path2 -Algorithm SHA256
        return ($first.Hash -ieq $second.Hash)
    }

    # The local path a file:// URL names, or $null for any other URL.
    function Get-FileUrlPath {
        param([string]$Url)
        if (-not $Url.StartsWith('file://', [StringComparison]::OrdinalIgnoreCase)) {
            return $null
        }
        return ([Uri]$Url).LocalPath
    }

    # The latest release tag: under file:// the <base>/latest file holds it;
    # over https it is the last part of the URL the <base>/latest redirect ends
    # at.
    function Get-ReleaseTag {
        param([string]$Base)
        $url = "$Base/latest"
        $local = Get-FileUrlPath $url
        if ($null -ne $local) {
            try {
                return ([IO.File]::ReadAllText($local)).Trim()
            } catch {
                throw "could not download $url."
            }
        }
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        try {
            $request = [Net.WebRequest]::Create($url)
            $response = $request.GetResponse()
            try {
                $final = $response.ResponseUri.AbsoluteUri
            } finally {
                $response.Close()
            }
        } catch {
            throw "could not download $url."
        }
        return $final.Substring($final.LastIndexOf('/') + 1)
    }

    # The latest release tag: through gh when it carries the release, else the
    # <base>/latest redirect (or file).
    function Get-LatestTag {
        param([string]$Base, [bool]$UseGh)
        if (-not $UseGh) {
            return Get-ReleaseTag $Base
        }
        $ErrorActionPreference = 'Continue'
        $tag = (& gh release view --repo makubexD/SyncSettings --json tagName -q .tagName 2>$null |
            Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return ''
        }
        return $tag
    }

    # Download a release URL to a file, or throw with the URL that failed.
    function Get-ReleaseFile {
        param([string]$Url, [string]$OutFile)
        $local = Get-FileUrlPath $Url
        if ($null -ne $local) {
            if (-not (Test-Path -LiteralPath $local -PathType Leaf)) {
                throw "could not download $Url."
            }
            Copy-Item -LiteralPath $local -Destination $OutFile -Force
            return
        }
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -OutFile $OutFile
        } catch {
            throw "could not download $Url."
        }
    }

    # Download the release asset and SHA256SUMS through gh into $Dir, for a
    # private repo too.
    function Get-GhReleaseFile {
        param([string]$Tag, [string]$Asset, [string]$Dir)
        $arguments = @(
            'release', 'download', $Tag, '--repo', 'makubexD/SyncSettings',
            '-p', $Asset, '-p', 'SHA256SUMS', '-D', $Dir
        )
        if ((Invoke-Gh $arguments) -ne 0) {
            throw "could not download https://github.com/makubexD/SyncSettings/releases/download/$Tag/$Asset."
        }
    }

    # The digest SHA256SUMS holds for $Name, or '' when it has no line for it.
    function Get-SumFor {
        param([string]$SumsFile, [string]$Name)
        foreach ($line in [IO.File]::ReadAllLines($SumsFile)) {
            $text = $line.Trim()
            if (-not $text.EndsWith(' ' + $Name)) {
                continue
            }
            $rest = $text.Substring(0, $text.Length - $Name.Length - 1).Trim()
            return $rest.Split(' ')[0]
        }
        return ''
    }

    # The release asset for this CPU, or stops when there is no program for it.
    # SYNC_ARCH overrides PROCESSOR_ARCHITECTURE for the tests.
    function Get-ProgramAsset {
        $arch = Get-Setting 'SYNC_ARCH' $env:PROCESSOR_ARCHITECTURE
        if ($arch -eq 'AMD64') {
            return 'mksync-windows-x64.exe'
        }
        throw "no mksync program for windows $arch."
    }

    $downloadDir = $null
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
        $bin = Get-Setting 'SYNCSETTINGS_BIN' (Join-Path $env:LOCALAPPDATA 'mksync')
        $yes = ($env:SYNCSETTINGS_YES -eq '1')
        $noSetup = ($env:SYNCSETTINGS_NO_SETUP -eq '1')
        $runtime = Get-Setting 'SYNCSETTINGS_RUNTIME' ''
        if ($runtime -ne '' -and $runtime -ne 'bun' -and $runtime -ne 'node') {
            throw 'SYNCSETTINGS_RUNTIME must be bun or node.'
        }

        # 2. Tools: git is required, gh opens pull requests and, when signed
        #    in, carries the clone and the release files.
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

        $gh = Get-ToolCommand 'gh'
        if ($null -eq $gh) {
            Write-Host '  Note: gh is not installed; mksync push cannot open a pull request. Install it from https://cli.github.com.'
        }

        # True when gh carries the clone and the release files: it is signed in
        # and SYNCSETTINGS_RELEASE_URL names no other release. Decided once,
        # here.
        $ghRelease = $false
        if ($null -ne $gh -and [string]::IsNullOrEmpty((Get-Setting 'SYNCSETTINGS_RELEASE_URL' ''))) {
            if ((Invoke-Gh @('auth', 'status')) -eq 0) {
                $ghRelease = $true
            }
        }

        # 3. The repo clone: update one, or make a new one. With gh signed in,
        #    the clone carries gh's credential helper, and so does a pull from
        #    github.com, where a pull from anywhere else has none.
        $gitOptions = @()
        if ($ghRelease) {
            $gitOptions = Get-GhGitOptions
        }
        if (Test-IsCloneWithOrigin $dir) {
            $pullOptions = @()
            if ($ghRelease -and
                (Test-GitHubUrl (Get-GitOutput @('-C', $dir, 'remote', 'get-url', 'origin')))) {
                $pullOptions = $gitOptions
            }
            if ((Invoke-Git (@($pullOptions) + @('-C', $dir, 'pull', '--ff-only', '-q'))) -ne 0) {
                throw "could not update $dir; resolve it and run this again."
            }
            Write-Host "  Updated $dir"
        } else {
            if (Test-DirNonEmpty $dir) {
                throw "$dir exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR."
            }
            if ((Invoke-Git (@($gitOptions) + @('clone', '-q', '--branch', $ref, $url, $dir))) -ne 0) {
                throw "could not clone $url."
            }
            Write-Host "  Cloned into $dir"
        }

        if (-not (Test-Path -LiteralPath (Join-Path $dir 'mksync.cmd')) -or
            -not (Test-Path -LiteralPath (Join-Path $dir 'sync-config.json'))) {
            throw "$dir doesn't look like SyncSettings."
        }

        if ($ghRelease) {
            Set-CloneGitLogin $dir
        }

        # 4. The mksync program in the bin folder: the latest release's
        #    mksync.exe, or with a runtime, a shim to the clone's launcher.
        $shim = Join-Path $bin 'mksync.cmd'
        $sh = Join-Path $bin 'mksync'
        $target = Join-Path $bin 'mksync.exe'

        if ($runtime -ne '') {
            if (Test-Path -LiteralPath $target) {
                throw "$target already exists; remove it and run this again."
            }
            if ((Test-Path -LiteralPath $shim) -and -not (Test-OursCmd $shim)) {
                throw "$shim already exists; remove it and run this again."
            }
            if ((Test-Path -LiteralPath $sh) -and -not (Test-OursSh $sh)) {
                throw "$sh already exists; remove it and run this again."
            }
            $null = New-Item -ItemType Directory -Path $bin -Force
            $content = "@echo off`r`n" +
                "rem SyncSettings launcher`r`n" +
                "call `"$dir\mksync.cmd`" %*`r`n" +
                "exit /b %ERRORLEVEL%`r`n"
            [IO.File]::WriteAllText($shim, $content, [Text.Encoding]::ASCII)
            $content = "#!/bin/sh`n" +
                "# SyncSettings launcher`n" +
                "exec `"$($dir.Replace('\', '/'))/mksync`" `"`$@`"`n"
            [IO.File]::WriteAllText($sh, $content, [Text.Encoding]::ASCII)
        } else {
            $asset = Get-ProgramAsset
            $base = Get-Setting 'SYNCSETTINGS_RELEASE_URL' 'https://github.com/makubexD/SyncSettings/releases'
            $downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('mksync-' + [Guid]::NewGuid().ToString('N'))
            $null = New-Item -ItemType Directory -Path $downloadDir -Force
            $tag = Get-LatestTag $base $ghRelease
            if ([string]::IsNullOrEmpty($tag)) {
                throw "could not find the latest release at $base."
            }
            if ($ghRelease) {
                Get-GhReleaseFile $tag $asset $downloadDir
            } else {
                Get-ReleaseFile "$base/download/$tag/$asset" (Join-Path $downloadDir $asset)
                Get-ReleaseFile "$base/download/$tag/SHA256SUMS" (Join-Path $downloadDir 'SHA256SUMS')
            }

            $sum = Get-SumFor (Join-Path $downloadDir 'SHA256SUMS') $asset
            $hash = (Get-FileHash -LiteralPath (Join-Path $downloadDir $asset) -Algorithm SHA256).Hash
            if ([string]::IsNullOrEmpty($sum) -or $hash -ine $sum) {
                throw "$asset`: checksum does not match SHA256SUMS."
            }

            # Nothing is written to the bin folder before the checksum passes.
            if (Test-Path -LiteralPath $shim) {
                if (-not (Test-OursCmd $shim)) {
                    throw "$shim already exists; remove it and run this again."
                }
            }
            if (Test-Path -LiteralPath $sh) {
                if (-not (Test-OursSh $sh)) {
                    throw "$sh already exists; remove it and run this again."
                }
            }
            if (Test-Path -LiteralPath $shim) {
                Remove-Item -LiteralPath $shim -Force
            }
            if (Test-Path -LiteralPath $sh) {
                Remove-Item -LiteralPath $sh -Force
            }
            $write = $true
            if (Test-Path -LiteralPath $target) {
                if (Test-SameFile $target (Join-Path $downloadDir $asset)) {
                    $write = $false
                } else {
                    throw "$target already exists; remove it and run this again."
                }
            }
            if ($write) {
                $null = New-Item -ItemType Directory -Path $bin -Force
                $temp = Join-Path $bin ('.mksync-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                Copy-Item -LiteralPath (Join-Path $downloadDir $asset) -Destination $temp
                Move-Item -LiteralPath $temp -Destination $target
            }
        }

        # The old default launcher from earlier installers, when it is ours and
        # not the one this bin folder has.
        $oldLauncher = Join-Path $env:LOCALAPPDATA 'SyncSettings\bin\mksync.cmd'
        if ((Test-Path -LiteralPath $oldLauncher -PathType Leaf) -and
            ($oldLauncher.TrimEnd('\') -ine $shim.TrimEnd('\')) -and
            (Test-OursCmd $oldLauncher)) {
            Remove-Item -LiteralPath $oldLauncher -Force
            Write-Host "  Removed the old launcher $oldLauncher."
        }

        # 5. The bin folder on the user Path, once.
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

        # 6. Setup, unless the caller skipped it.
        if (-not $noSetup) {
            $program = $target
            if ($runtime -ne '') {
                $program = $shim
            }
            $setupArgs = @('setup')
            if ($yes) {
                $setupArgs += '--yes'
            }
            # Out-Host streams setup's output (and its prompts) as it runs, and
            # keeps it out of this function's return value.
            & $program @setupArgs | Out-Host
            $setupCode = $LASTEXITCODE
            if ($setupCode -ne 0) {
                throw 'setup failed; run mksync setup to see why.'
            }
        }

        # 7. Done.
        Write-Host '  Installed. Run mksync any time.'
        return 0
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        return 1
    } finally {
        if (-not [string]::IsNullOrEmpty($downloadDir)) {
            Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($PSCommandPath) { exit (Install-SyncSettings) } else { $null = Install-SyncSettings }
