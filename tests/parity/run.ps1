#Requires -Version 5.1
# Shared parity cases: run every case in tests/parity/cases/ against the
# PowerShell engine in a throwaway USERPROFILE, LOCALAPPDATA and repo, then
# compare exit codes, status lines and both trees with expect/. The case format
# is tests/parity/README.md.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1 [case-name-filter]

$ErrorActionPreference = 'Stop'

$SourceDir = $PSScriptRoot
$Repo = (Resolve-Path (Join-Path $SourceDir '..\..')).Path
$Cases = $env:PARITY_CASES
if ([string]::IsNullOrEmpty($Cases)) {
    $Cases = Join-Path $Repo 'tests\parity\cases'
}

$Filter = ''
if ($args.Count -gt 0) {
    $Filter = $args[0]
}

$passed = 0
$failed = 0
$matched = 0

# The runner is Windows-only: every case runs for the PowerShell engine.
$HarnessOs = 'windows'

# Status words the engines print. Longer words first so CREATED and UPDATED win
# over CREATE and UPDATE in the alternation.
$StatusWords = 'ADDED|UNCHANGED|MODIFIED|SKIPPED|REMOVED|ERROR|CREATED|UPDATED|EXTRA|ORPHAN|DRIFT|CREATE|UPDATE'

# -- Helpers -------------------------------------------------------------------

function Die {
    param([string]$Message)
    throw $Message
}

# Check case.json before anything is copied or run. Dies with a short reason;
# the caller runs this in a try/catch so only that case FAILs.
function Validate-Case {
    param([string]$Dir)

    $json = Join-Path $Dir 'case.json'
    if (-not (Test-Path -LiteralPath $json -PathType Leaf)) {
        Die 'case.json is missing'
    }

    $case = $null
    try {
        $case = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
    } catch {
        Die 'case.json is not a JSON object'
    }
    if ($case -isnot [pscustomobject]) {
        Die 'case.json is not a JSON object'
    }

    $commands = $case.commands
    if ($null -eq $commands -or $commands -isnot [System.Array] -or $commands.Count -eq 0) {
        Die 'commands must be a non-empty array'
    }

    foreach ($cmd in $commands) {
        if ($cmd -isnot [pscustomobject] -or $cmd.command -isnot [string]) {
            Die 'every command must be an object with a string command'
        }

        $optsProp = $cmd.PSObject.Properties['options']
        if ($null -ne $optsProp) {
            $opts = $optsProp.Value
            if ($opts -isnot [pscustomobject]) {
                Die 'options must be an object'
            }
            $forceProp = $opts.PSObject.Properties['force']
            if ($null -ne $forceProp -and $forceProp.Value -isnot [bool]) {
                Die 'options.force must be a boolean'
            }
            $onlyProp = $opts.PSObject.Properties['only']
            if ($null -ne $onlyProp) {
                $only = $onlyProp.Value
                if ($only -isnot [System.Array]) {
                    Die 'options.only must be an array of strings'
                }
                foreach ($p in $only) {
                    if ($p -isnot [string]) {
                        Die 'options.only must be an array of strings'
                    }
                }
            }
        }

        $stdinProp = $cmd.PSObject.Properties['stdin']
        if ($null -ne $stdinProp -and $stdinProp.Value -isnot [string]) {
            Die 'stdin must be a string'
        }
    }

    $osProp = $case.PSObject.Properties['os']
    if ($null -ne $osProp) {
        $os = $osProp.Value
        if ($os -isnot [System.Array]) {
            Die 'os must be a list of linux, macos or windows'
        }
        foreach ($o in $os) {
            if (-not ($o -is [string] -and ($o -ceq 'linux' -or $o -ceq 'macos' -or $o -ceq 'windows'))) {
                Die 'os must be a list of linux, macos or windows'
            }
        }
    }

    $gitProp = $case.PSObject.Properties['git']
    if ($null -ne $gitProp) {
        $g = $gitProp.Value
        if (-not ($g -is [string] -and ($g -ceq 'none' -or $g -ceq 'committed' -or $g -ceq 'remote'))) {
            Die 'git must be none, committed or remote'
        }
    }

    $stubsProp = $case.PSObject.Properties['stubs']
    if ($null -ne $stubsProp) {
        $stubs = $stubsProp.Value
        if ($stubs -isnot [System.Array]) {
            Die 'stubs may only hold gh'
        }
        foreach ($s in $stubs) {
            if (-not ($s -is [string] -and $s -ceq 'gh')) {
                Die 'stubs may only hold gh'
            }
        }
    }

    $osFolder = $false
    $expectFolders = @(Get-ChildItem -LiteralPath $Dir -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'expect.*' })
    foreach ($f in $expectFolders) {
        $suffix = $f.Name.Substring('expect.'.Length)
        if ($suffix -ceq 'linux' -or $suffix -ceq 'macos' -or $suffix -ceq 'windows') {
            $osFolder = $true
        } else {
            Die "expect.${suffix}: unknown OS folder"
        }
    }

    $differencesProp = $case.PSObject.Properties['differences']
    $hasDifferences = $null -ne $differencesProp

    if ($osFolder) {
        $ok = $false
        if ($null -ne $differencesProp) {
            $diffs = $differencesProp.Value
            if ($diffs -is [System.Array] -and $diffs.Count -gt 0) {
                $allStrings = $true
                foreach ($d in $diffs) {
                    if ($d -isnot [string]) {
                        $allStrings = $false
                        break
                    }
                }
                $ok = $allStrings
            }
        }
        if (-not $ok) {
            Die 'differences must name the Known differences rows for expect.<os>/'
        }
    }

    if ($hasDifferences -and -not $osFolder) {
        Die 'differences set but no expect.<os>/ folder'
    }

    if (Test-Path -LiteralPath (Join-Path $Dir 'repo\packages') -PathType Container) {
        Die 'packages/ needs the drift stubs from phase 2'
    }

    return $case
}

# The expected file or tree for $Name: expect.<os>\<Name> when it exists for the
# OS the runner is on, else expect\<Name>.
function Get-ExpectedPath {
    param([string]$Dir, [string]$Name)
    $perOs = Join-Path $Dir ("expect.$HarnessOs\$Name")
    if (Test-Path -LiteralPath $perOs) {
        return $perOs
    }
    return (Join-Path $Dir ("expect\$Name"))
}

# The lines of a text file, as bash `mapfile -t` reads them: split on newlines,
# a trailing newline dropped, a trailing carriage return kept.
function Read-Lines {
    param([string]$Path)
    $content = [IO.File]::ReadAllText($Path)
    if ($content.Length -eq 0) {
        return ,@()
    }
    if ($content.EndsWith("`n")) {
        $content = $content.Substring(0, $content.Length - 1)
    }
    $lines = $content -split "`n"
    return ,$lines
}

# The status lines of a command's output, each as `WORD label`: ANSI color codes
# removed, notes and every other line dropped (see the README's "How the runner
# checks it").
function Get-StatusLines {
    param([string]$Raw)
    $text = $Raw -creplace '\x1b\[[0-9;]*[A-Za-z]', ''
    $text = $text -replace "`r`n", "`n"
    $text = $text -replace "`r", "`n"
    $result = @()
    foreach ($line in ($text -split "`n")) {
        if ($line -eq '') {
            continue
        }
        # A prompt answered from a pipe ends with no newline, so its status line
        # follows it on the same line: drop the `...? [Y/n]` prefix first.
        $line = $line -creplace '^.*\? \[[Yy]/[Nn]\][ \t]*', ''
        $pattern = '^\s*\[?\s*(' + $StatusWords + ')\s*\]?\s+(\S+)'
        if ($line -cmatch $pattern) {
            $result += ($Matches[1] + ' ' + $Matches[2])
        }
    }
    return ,$result
}

# Compare two line lists, one line per command or per status line. $What is the
# name `exit` or `output`; a missing wanted file means nothing was expected.
function Compare-Lines {
    param([string]$What, [string[]]$Want, [string[]]$Got)
    $wantCount = 0
    if ($null -ne $Want) {
        $wantCount = $Want.Count
    }
    $gotCount = 0
    if ($null -ne $Got) {
        $gotCount = $Got.Count
    }
    $count = $wantCount
    if ($gotCount -gt $count) {
        $count = $gotCount
    }
    for ($n = 0; $n -lt $count; $n++) {
        $w = ''
        if ($n -lt $wantCount) {
            $w = $Want[$n]
        }
        $g = ''
        if ($n -lt $gotCount) {
            $g = $Got[$n]
        }
        if ($w -ceq $g) {
            continue
        }
        if ($n -ge $gotCount) {
            Die "$What line $($n + 1): want `"$w`", got nothing"
        }
        if ($n -ge $wantCount) {
            Die "$What line $($n + 1): want nothing, got `"$g`""
        }
        if ($What -ceq 'exit' -and $wantCount -eq 1 -and $gotCount -eq 1) {
            Die "exit: want $w, got $g"
        }
        if ($What -ceq 'exit') {
            Die "exit line $($n + 1): want $w, got $g"
        }
        Die "$What line $($n + 1): want `"$w`", got `"$g`""
    }
}

# The relative path (forward slashes) of every file and folder under $Root.
function Get-TreePaths {
    param([string]$Root)
    $list = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $Root -PathType Container) {
        $stack = New-Object System.Collections.Generic.Stack[string]
        $stack.Push($Root)
        while ($stack.Count -gt 0) {
            $current = $stack.Pop()
            foreach ($item in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
                # The temp repo's own .git folder is not part of the case.
                if ($item.PSIsContainer -and $item.Name -ceq '.git' -and $current -ceq $Root) {
                    continue
                }
                $rel = $item.FullName.Substring($Root.Length)
                $rel = $rel.TrimStart('\', '/')
                $rel = $rel -replace '\\', '/'
                $list.Add($rel)
                if ($item.PSIsContainer) {
                    $stack.Push($item.FullName)
                }
            }
        }
    }
    return ,$list.ToArray()
}

function Sort-Ordinal {
    param([string[]]$Items)
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        $list.Add($item)
    }
    $list.Sort([System.StringComparer]::Ordinal)
    return ,$list
}

# Compare the wanted and got trees: the file and folder path set must match,
# then every file must match by SHA256. No mode compare. The first difference
# names the file from the case's point of view.
function Compare-Trees {
    param([string]$WantDir, [string]$GotDir)
    $wantSorted = Sort-Ordinal (Get-TreePaths $WantDir)
    $gotSorted = Sort-Ordinal (Get-TreePaths $GotDir)

    $wi = 0
    $gi = 0
    while ($wi -lt $wantSorted.Count -or $gi -lt $gotSorted.Count) {
        $cmp = 0
        if ($wi -ge $wantSorted.Count) {
            $cmp = 1
        } elseif ($gi -ge $gotSorted.Count) {
            $cmp = -1
        } else {
            $cmp = [System.StringComparer]::Ordinal.Compare($wantSorted[$wi], $gotSorted[$gi])
        }

        if ($cmp -lt 0) {
            Die "only in want: $($wantSorted[$wi])"
        } elseif ($cmp -gt 0) {
            Die "only in got: $($gotSorted[$gi])"
        } else {
            $rel = $wantSorted[$wi]
            $wantFull = Join-Path $WantDir ($rel -replace '/', '\')
            $gotFull = Join-Path $GotDir ($rel -replace '/', '\')
            if (Test-Path -LiteralPath $wantFull -PathType Leaf) {
                $wantHash = (Get-FileHash -LiteralPath $wantFull -Algorithm SHA256).Hash
                $gotHash = (Get-FileHash -LiteralPath $gotFull -Algorithm SHA256).Hash
                if ($wantHash -cne $gotHash) {
                    Die "differs: $rel"
                }
            }
            $wi++
            $gi++
        }
    }
}

# Copy a directory tree, byte for byte, empty directories included.
function Copy-Tree {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        return
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop)) {
        $dest = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) {
            Copy-Tree -Source $item.FullName -Destination $dest
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
        }
    }
}

# Remove the engine files copied into the temp repo, so the repo comparison sees
# only the case's own files. `scripts` goes too when nothing is left in it.
function Remove-Engine {
    param([string]$RepoDir)
    foreach ($rel in @('sync.cmd', 'sync-config.json', '.user-values.json', 'scripts\windows', 'scripts\ci')) {
        $path = Join-Path $RepoDir $rel
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    $scriptsDir = Join-Path $RepoDir 'scripts'
    if (Test-Path -LiteralPath $scriptsDir -PathType Container) {
        $left = @(Get-ChildItem -LiteralPath $scriptsDir -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) {
            Remove-Item -LiteralPath $scriptsDir -Force -ErrorAction SilentlyContinue
        }
    }
}

# A values cache re-serialized with its keys sorted, so key order is ignored.
function Get-SortedValuesJson {
    param([string]$Path)
    $obj = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($obj -is [pscustomobject]) {
        $sorted = [ordered]@{}
        foreach ($name in (@($obj.PSObject.Properties.Name) | Sort-Object)) {
            $sorted[$name] = $obj.PSObject.Properties[$name].Value
        }
        return ($sorted | ConvertTo-Json -Compress)
    }
    return ($obj | ConvertTo-Json -Compress)
}

# git with the user's own configuration kept out of the case. $What names the
# operation for the failure message.
function Invoke-Git {
    param([string]$What, [string[]]$GitArgs)
    $oldGlobal = $env:GIT_CONFIG_GLOBAL
    $oldNoSystem = $env:GIT_CONFIG_NOSYSTEM
    $oldPreference = $ErrorActionPreference
    try {
        $env:GIT_CONFIG_GLOBAL = 'NUL'
        $env:GIT_CONFIG_NOSYSTEM = '1'
        $ErrorActionPreference = 'Continue'
        & git @GitArgs 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Die "$What failed"
        }
    } finally {
        $ErrorActionPreference = $oldPreference
        $env:GIT_CONFIG_GLOBAL = $oldGlobal
        $env:GIT_CONFIG_NOSYSTEM = $oldNoSystem
    }
}

# Put the case's temp repo under git: everything committed on master, and for
# `remote` also a bare origin at <temp>\origin.git that master tracks.
function Setup-Git {
    param([string]$RepoDir, [string]$TempDir, [string]$Mode)
    Invoke-Git -What 'git init' -GitArgs @('-C', $RepoDir, 'init', '-q', '-b', 'master')
    Invoke-Git -What 'git config user.name' -GitArgs @('-C', $RepoDir, 'config', 'user.name', 'Parity')
    Invoke-Git -What 'git config user.email' -GitArgs @('-C', $RepoDir, 'config', 'user.email', 'parity@example.com')
    Invoke-Git -What 'git config commit.gpgsign' -GitArgs @('-C', $RepoDir, 'config', 'commit.gpgsign', 'false')
    Invoke-Git -What 'git config core.autocrlf' -GitArgs @('-C', $RepoDir, 'config', 'core.autocrlf', 'false')
    [IO.File]::AppendAllText((Join-Path $RepoDir '.git\info\exclude'), ".user-values.json`n", [System.Text.UTF8Encoding]::new($false))
    Invoke-Git -What 'git add' -GitArgs @('-C', $RepoDir, 'add', '-A')
    Invoke-Git -What 'git commit' -GitArgs @('-C', $RepoDir, 'commit', '-q', '-m', 'parity case')
    if ($Mode -ceq 'remote') {
        Invoke-Git -What 'git init of origin' -GitArgs @('init', '-q', '--bare', '-b', 'master', (Join-Path $TempDir 'origin.git'))
        Invoke-Git -What 'git remote add' -GitArgs @('-C', $RepoDir, 'remote', 'add', 'origin', (Join-Path $TempDir 'origin.git'))
        Invoke-Git -What 'git push' -GitArgs @('-C', $RepoDir, 'push', '-q', '-u', 'origin', 'master')
    }
}

# Write the gh stub into <temp>\bin: a gh.cmd that appends each call's arguments,
# one call per line, to <temp>\gh.log, prints nothing and exits 0.
function Write-GhStub {
    param([string]$TempDir)
    $binDir = Join-Path $TempDir 'bin'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $logPath = Join-Path $TempDir 'gh.log'
    $body = "@echo off`r`necho(%*>>`"$logPath`"`r`n"
    [IO.File]::WriteAllText((Join-Path $binDir 'gh.cmd'), $body, [System.Text.UTF8Encoding]::new($false))
}

# -- One case ------------------------------------------------------------------

# Runs one case in a fresh throwaway folder, throwing the first difference.
# The caller catches the exception; the temp folder is removed in finally.
function Run-Case {
    param([string]$Dir, $Case)

    $t = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $t -Force | Out-Null

        $repoDir = Join-Path $t 'repo'
        $homeDir = Join-Path $t 'home'
        $localDir = Join-Path $t 'localappdata'
        $emptyDir = Join-Path $t 'empty'
        New-Item -ItemType Directory -Path $repoDir -Force | Out-Null
        New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
        New-Item -ItemType Directory -Path $localDir -Force | Out-Null
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null

        # Engine files (scripts\ci too: later cases need leak-scan).
        Copy-Item -LiteralPath (Join-Path $Repo 'sync.cmd') -Destination $repoDir -Force
        New-Item -ItemType Directory -Path (Join-Path $repoDir 'scripts') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $Repo 'scripts\windows') -Destination (Join-Path $repoDir 'scripts\windows') -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $Repo 'scripts\ci') -Destination (Join-Path $repoDir 'scripts\ci') -Recurse -Force

        # Config and values
        $configProp = $Case.PSObject.Properties['config']
        if ($null -eq $configProp) {
            Die 'case.json has no config'
        }
        $configJson = $configProp.Value | ConvertTo-Json -Depth 32 -Compress
        [IO.File]::WriteAllText((Join-Path $repoDir 'sync-config.json'), $configJson, [System.Text.UTF8Encoding]::new($false))

        $valuesProp = $Case.PSObject.Properties['values']
        if ($null -ne $valuesProp) {
            $valuesJson = $valuesProp.Value | ConvertTo-Json -Depth 32 -Compress
            [IO.File]::WriteAllText((Join-Path $repoDir '.user-values.json'), $valuesJson, [System.Text.UTF8Encoding]::new($false))
        }

        if (Test-Path -LiteralPath (Join-Path $Dir 'repo') -PathType Container) {
            Copy-Tree (Join-Path $Dir 'repo') $repoDir
        }
        if (Test-Path -LiteralPath (Join-Path $Dir 'home') -PathType Container) {
            Copy-Tree (Join-Path $Dir 'home') $homeDir
        }

        # Git: everything committed on master, and for `remote` also a bare
        # origin the repo was pushed to.
        $gitMode = 'none'
        $gitProp = $Case.PSObject.Properties['git']
        if ($null -ne $gitProp) {
            $gitMode = [string]$gitProp.Value
        }
        if ($gitMode -ceq 'committed' -or $gitMode -ceq 'remote') {
            Setup-Git -RepoDir $repoDir -TempDir $t -Mode $gitMode
        }

        # gh stub: first on PATH for every command, logging each call's args.
        $ghStub = $false
        $stubsProp = $Case.PSObject.Properties['stubs']
        if ($null -ne $stubsProp -and (@($stubsProp.Value) -ccontains 'gh')) {
            $ghStub = $true
            Write-GhStub -TempDir $t
        }

        # Commands
        $commands = $Case.commands
        $exitCodes = New-Object System.Collections.Generic.List[string]
        $statusOut = New-Object System.Collections.Generic.List[string]

        for ($i = 0; $i -lt $commands.Count; $i++) {
            $cmdObj = $commands[$i]
            $cmd = [string]$cmdObj.command

            $scriptPath = $null
            $extraArgs = @()
            switch -CaseSensitive ($cmd) {
                'export'  { $scriptPath = Join-Path $repoDir 'scripts\windows\Export-Settings.ps1' }
                'import'  { $scriptPath = Join-Path $repoDir 'scripts\windows\Import-Settings.ps1' }
                'check'   { $scriptPath = Join-Path $repoDir 'scripts\windows\Import-Settings.ps1'; $extraArgs += '-Check' }
                'preview' { $scriptPath = Join-Path $repoDir 'scripts\windows\Export-Settings.ps1'; $extraArgs += '-Preview' }
                'diff'    { $scriptPath = Join-Path $repoDir 'scripts\windows\Export-Settings.ps1'; $extraArgs += '-Diff' }
                'commit'  { $scriptPath = Join-Path $repoDir 'scripts\windows\Commit-Settings.ps1' }
                default   { Die "unknown command '$cmd' in command $($i + 1)" }
            }

            $optsProp = $cmdObj.PSObject.Properties['options']
            if ($null -ne $optsProp) {
                $opts = $optsProp.Value
                foreach ($key in $opts.PSObject.Properties.Name) {
                    if ($key -cne 'force' -and $key -cne 'only') {
                        Die "unknown option '$key' in command $($i + 1)"
                    }
                }
                $forceProp = $opts.PSObject.Properties['force']
                if ($null -ne $forceProp -and $forceProp.Value -eq $true) {
                    $extraArgs += '-Force'
                }
                $onlyProp = $opts.PSObject.Properties['only']
                if ($null -ne $onlyProp) {
                    $onlyPaths = @($onlyProp.Value)
                    if ($onlyPaths.Count -gt 0) {
                        $extraArgs += '-Only'
                        $extraArgs += ($onlyPaths -join '|')
                    }
                }
            }

            $stdinText = ''
            $stdinProp = $cmdObj.PSObject.Properties['stdin']
            if ($null -ne $stdinProp) {
                $stdinText = [string]$stdinProp.Value
            }

            $procArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath) + $extraArgs

            $oldProfile = $env:USERPROFILE
            $oldHome = $env:HOME
            $oldLocal = $env:LOCALAPPDATA
            $oldPath = $env:PATH
            $oldPreference = $ErrorActionPreference
            Push-Location $repoDir
            try {
                $env:USERPROFILE = $homeDir
                $env:HOME = $homeDir
                $env:LOCALAPPDATA = $localDir
                if ($ghStub) {
                    $env:PATH = (Join-Path $t 'bin') + ';' + $env:PATH
                }
                # In PS 5.1 a native command's stderr redirected with 2>&1 turns
                # into error records, which 'Stop' would throw on.
                $ErrorActionPreference = 'Continue'
                $raw = $stdinText | & powershell.exe @procArgs 2>&1 | Out-String
                $rc = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $oldPreference
                $env:USERPROFILE = $oldProfile
                $env:HOME = $oldHome
                $env:LOCALAPPDATA = $oldLocal
                $env:PATH = $oldPath
                Pop-Location
            }

            $exitCodes.Add([string]$rc)
            foreach ($line in (Get-StatusLines $raw)) {
                $statusOut.Add($line)
            }
        }

        # Each gh call is cut to its first two words, so branch names and titles
        # don't matter. No expected file means gh must not be called.
        if ($ghStub) {
            $ghCut = New-Object System.Collections.Generic.List[string]
            $ghLogPath = Join-Path $t 'gh.log'
            if (Test-Path -LiteralPath $ghLogPath -PathType Leaf) {
                foreach ($line in (Read-Lines $ghLogPath)) {
                    $line = $line.TrimEnd("`r")
                    if ($line -eq '') {
                        continue
                    }
                    $words = @($line -split ' +')
                    if ($words.Count -eq 1) {
                        $ghCut.Add($words[0])
                    } else {
                        $ghCut.Add($words[0] + ' ' + $words[1])
                    }
                }
            }
            $wantGh = Get-ExpectedPath $Dir 'gh.log'
            if (Test-Path -LiteralPath $wantGh -PathType Leaf) {
                Compare-Lines -What 'gh' -Want (Read-Lines $wantGh) -Got $ghCut.ToArray()
            } elseif ($ghCut.Count -gt 0) {
                Die "gh: want no call, got `"$($ghCut[0])`""
            }
        }

        # The repo's values cache is compared as JSON, key order ignored, before
        # the engine files are stripped from the repo.
        $wantValues = Get-ExpectedPath $Dir 'values.json'
        if (Test-Path -LiteralPath $wantValues) {
            $gotValuesFile = Join-Path $repoDir '.user-values.json'
            if (-not (Test-Path -LiteralPath $gotValuesFile -PathType Leaf)) {
                Die 'values.json: .user-values.json is missing'
            }
            $wantSortedJson = $null
            try { $wantSortedJson = Get-SortedValuesJson $wantValues } catch { Die 'values.json: expect is not valid JSON' }
            $gotSortedJson = $null
            try { $gotSortedJson = Get-SortedValuesJson $gotValuesFile } catch { Die 'values.json: .user-values.json is not valid JSON' }
            if ($wantSortedJson -cne $gotSortedJson) {
                Die 'values.json: differs from expect'
            }
        }

        # The engine's own state folder is not part of the case: take the copy
        # the case expects, then drop it (it lives outside home in localappdata).
        $wantState = Get-ExpectedPath $Dir 'state'
        $stateDir = $null
        if (Test-Path -LiteralPath $wantState -PathType Container) {
            $engineState = Join-Path $localDir 'SyncSettings'
            if (-not (Test-Path -LiteralPath $engineState -PathType Container)) {
                Die 'state: engine state folder is missing'
            }
            $stateDir = Join-Path $t 'state'
            Copy-Tree $engineState $stateDir

            $backupsDir = Join-Path $stateDir 'backups'
            $runs = @()
            if (Test-Path -LiteralPath $backupsDir -PathType Container) {
                $runs = @(Get-ChildItem -LiteralPath $backupsDir -Directory -Force)
            }
            if ($runs.Count -gt 0) {
                if ($runs.Count -ne 1) {
                    Die "state: want one backup run folder, got $($runs.Count)"
                }
                Rename-Item -LiteralPath $runs[0].FullName -NewName 'RUN'
            }
        }
        Remove-Item -LiteralPath (Join-Path $localDir 'SyncSettings') -Recurse -Force -ErrorAction SilentlyContinue

        if ($null -ne $stateDir) {
            foreach ($rel in (Get-TreePaths $wantState)) {
                $wantFile = Join-Path $wantState ($rel -replace '/', '\')
                if (-not (Test-Path -LiteralPath $wantFile -PathType Leaf)) {
                    continue
                }
                $gotFile = Join-Path $stateDir ($rel -replace '/', '\')
                if (-not (Test-Path -LiteralPath $gotFile -PathType Leaf)) {
                    Die "state ${rel}: missing"
                }
                $wantHash = (Get-FileHash -LiteralPath $wantFile -Algorithm SHA256).Hash
                $gotHash = (Get-FileHash -LiteralPath $gotFile -Algorithm SHA256).Hash
                if ($wantHash -cne $gotHash) {
                    Die "state ${rel}: differs"
                }
            }
        }

        # Exit codes and status lines
        $wantExit = Get-ExpectedPath $Dir 'exit'
        $wantExitLines = @()
        if (Test-Path -LiteralPath $wantExit -PathType Leaf) {
            $wantExitLines = Read-Lines $wantExit
        }
        Compare-Lines -What 'exit' -Want $wantExitLines -Got $exitCodes.ToArray()

        $wantOutput = Get-ExpectedPath $Dir 'output.txt'
        $wantOutputLines = @()
        if (Test-Path -LiteralPath $wantOutput -PathType Leaf) {
            $wantOutputLines = Read-Lines $wantOutput
        }
        Compare-Lines -What 'output' -Want $wantOutputLines -Got $statusOut.ToArray()

        # Home tree: an absent expect home means the tree must be empty.
        $wantHome = Get-ExpectedPath $Dir 'home'
        $homeWantDir = $emptyDir
        if (Test-Path -LiteralPath $wantHome -PathType Container) {
            $homeWantDir = $wantHome
        }
        Compare-Trees $homeWantDir $homeDir

        # Repo tree, after the engine files are stripped. An absent expect repo
        # means the tree must be empty.
        Remove-Engine $repoDir
        $wantRepo = Get-ExpectedPath $Dir 'repo'
        $repoWantDir = $emptyDir
        if (Test-Path -LiteralPath $wantRepo -PathType Container) {
            $repoWantDir = $wantRepo
        }
        Compare-Trees $repoWantDir $repoDir
    } finally {
        Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# -- Runner --------------------------------------------------------------------

$caseDirs = @(Get-ChildItem -LiteralPath $Cases -Directory -ErrorAction SilentlyContinue | Sort-Object Name)

foreach ($caseDir in $caseDirs) {
    $dir = $caseDir.FullName
    $caseName = $caseDir.Name

    if ($Filter -ne '' -and $caseName -notlike "*$Filter*") {
        continue
    }
    $matched++

    $reason = $null
    $case = $null
    try {
        $case = Validate-Case -Dir $dir
    } catch {
        $reason = $_.Exception.Message
        if ([string]::IsNullOrEmpty($reason)) {
            $reason = 'invalid case.json'
        }
        Write-Output "FAIL ${caseName}: $reason"
        $failed++
        continue
    }

    $osProp = $case.PSObject.Properties['os']
    if ($null -ne $osProp) {
        if (-not (@($osProp.Value) -ccontains 'windows')) {
            Write-Output "skip $caseName"
            continue
        }
    }

    $reason = $null
    try {
        Run-Case -Dir $dir -Case $case
    } catch {
        $reason = $_.Exception.Message
        if ([string]::IsNullOrEmpty($reason)) {
            $reason = 'unknown failure'
        }
        Write-Output "FAIL ${caseName}: $reason"
        $failed++
        continue
    }
    Write-Output "ok $caseName"
    $passed++
}

if ($Filter -ne '' -and $matched -eq 0) {
    Write-Output "no case matches $Filter"
    exit 1
}

Write-Output "$passed passed, $failed failed"

if ($failed -gt 0) {
    exit 1
}
