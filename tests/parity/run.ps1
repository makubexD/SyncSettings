#Requires -Version 5.1
# Shared parity cases: run every case in tests/parity/cases/ against the
# compiled program in a throwaway USERPROFILE, LOCALAPPDATA and repo, then
# compare exit codes, status lines and both trees with expect/. The case format
# is tests/parity/README.md.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1 [-Engine <path>] [case-name-filter]

$ErrorActionPreference = 'Stop'

$SourceDir = $PSScriptRoot
$Repo = (Resolve-Path (Join-Path $SourceDir '..\..')).Path
$Cases = $env:PARITY_CASES
if ([string]::IsNullOrEmpty($Cases)) {
    $Cases = Join-Path $Repo 'tests\parity\cases'
}

# -Engine <path> picks the program to run, default dist\mksync.exe. The rest is
# the case filter.
$EnginePath = Join-Path $Repo 'dist\mksync.exe'
$Filter = ''
$argIndex = 0
while ($argIndex -lt $args.Count) {
    $argValue = [string]$args[$argIndex]
    if ($argValue -ceq '-Engine') {
        if ($argIndex + 1 -ge $args.Count) {
            Write-Output '-Engine needs a path'
            exit 1
        }
        $argIndex++
        $EnginePath = [string]$args[$argIndex]
    } else {
        $Filter = $argValue
    }
    $argIndex++
}

if (-not (Test-Path -LiteralPath $EnginePath -PathType Leaf)) {
    Write-Output "-Engine: $EnginePath is not a file"
    exit 1
}
$EnginePath = (Resolve-Path -LiteralPath $EnginePath).Path

$passed = 0
$failed = 0
$matched = 0

# The runner is Windows-only: every case runs for the program.
$HarnessOs = 'windows'

# Status words the engines print. Longer words first so CREATED and UPDATED win
# over CREATE and UPDATE in the alternation. IN, OUT, BOTH and ? are diff labels.
$StatusWords = 'ADDED|UNCHANGED|MODIFIED|SKIPPED|REMOVED|ERROR|CREATED|UPDATED|EXTRA|ORPHAN|DRIFT|CREATE|UPDATE|IN|OUT|BOTH|\?'

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
        $case = [IO.File]::ReadAllText($json, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
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
        $opts = $null
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
            $pathsProp = $opts.PSObject.Properties['paths']
            if ($null -ne $pathsProp) {
                $paths = $pathsProp.Value
                if ($paths -isnot [System.Array]) {
                    Die 'options.paths must be an array of strings'
                }
                foreach ($p in $paths) {
                    if ($p -isnot [string]) {
                        Die 'options.paths must be an array of strings'
                    }
                }
            }
            foreach ($key in @('name', 'profile', 'replace', 'claude', 'mode', 'existing', 'target')) {
                $p = $opts.PSObject.Properties[$key]
                if ($null -ne $p -and $p.Value -isnot [string]) {
                    Die 'options name, profile, replace, claude, mode, existing and target must be strings'
                }
            }
            $yesProp = $opts.PSObject.Properties['yes']
            if ($null -ne $yesProp -and $yesProp.Value -isnot [bool]) {
                Die 'options.yes must be a boolean'
            }
            $bootstrapProp = $opts.PSObject.Properties['bootstrap']
            if ($null -ne $bootstrapProp -and $bootstrapProp.Value -isnot [bool]) {
                Die 'options.bootstrap must be a boolean'
            }
            $partialProp = $opts.PSObject.Properties['partial']
            if ($null -ne $partialProp -and $partialProp.Value -isnot [bool]) {
                Die 'options.partial must be a boolean'
            }
            $messageProp = $opts.PSObject.Properties['message']
            if ($null -ne $messageProp -and $messageProp.Value -isnot [string]) {
                Die 'options.message must be a string'
            }
            $resetProp = $opts.PSObject.Properties['resetValues']
            if ($null -ne $resetProp -and $resetProp.Value -isnot [bool]) {
                Die 'options.resetValues must be a boolean'
            }
        }

        $optNames = @()
        if ($null -ne $opts) {
            $optNames = @($opts.PSObject.Properties.Name)
        }
        foreach ($key in @('name', 'profile', 'replace', 'claude', 'mode', 'existing')) {
            if ($optNames -ccontains $key -and $cmd.command -cne 'setup') {
                Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire or profile-retire'
            }
        }
        $frontDoor = $cmd.command -ceq 'status' -or $cmd.command -ceq 'doctor' -or
            $cmd.command -ceq 'pull' -or $cmd.command -ceq 'push' -or $cmd.command -ceq 'front-diff'
        if ($optNames -ccontains 'yes' -and $cmd.command -cne 'setup' -and $cmd.command -cne 'export' -and
            $cmd.command -cne 'preview' -and $cmd.command -cne 'machine-retire' -and
            $cmd.command -cne 'profile-retire' -and -not $frontDoor) {
            Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
        }
        if ($optNames -ccontains 'bootstrap' -and $cmd.command -cne 'setup') {
            Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
        }
        if ($optNames -ccontains 'partial' -and $cmd.command -cne 'commit') {
            Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
        }
        if ($optNames -ccontains 'message' -and $cmd.command -cne 'commit' -and $cmd.command -cne 'push') {
            Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
        }
        if ($optNames -ccontains 'paths' -and -not $frontDoor -and $cmd.command -cne 'front-check') {
            Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
        }
        if ($optNames -ccontains 'resetValues' -and $cmd.command -cne 'import' -and $cmd.command -cne 'check') {
            Die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
        }
        $isRetire = $cmd.command -ceq 'machine-retire' -or $cmd.command -ceq 'profile-retire'
        if ($isRetire -ne ($optNames -ccontains 'target')) {
            Die 'options.target is required for machine-retire and profile-retire, and nowhere else'
        }

        $stdinProp = $cmd.PSObject.Properties['stdin']
        if ($null -ne $stdinProp -and $stdinProp.Value -isnot [string]) {
            Die 'stdin must be a string'
        }

        $stderrProp = $cmd.PSObject.Properties['stderr']
        if ($null -ne $stderrProp -and $stderrProp.Value -isnot [bool]) {
            Die 'stderr must be a boolean'
        }

        $outputProp = $cmd.PSObject.Properties['output']
        if ($null -ne $outputProp -and -not ($outputProp.Value -is [string] -and $outputProp.Value -ceq 'all')) {
            Die 'output must be "all"'
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

    # Only configV2: the v1 config went at cut-over.
    if ($null -ne $case.PSObject.Properties['config']) {
        Die 'case.json has a v1 config'
    }
    $configV2Prop = $case.PSObject.Properties['configV2']
    if ($null -eq $configV2Prop) {
        Die 'case.json has no configV2'
    }

    # configName picks the file the config is written to; absent, the rule above.
    $configNameProp = $case.PSObject.Properties['configName']
    if ($null -ne $configNameProp) {
        $configName = $configNameProp.Value
        if (-not ($configName -is [string] -and ($configName -ceq 'sync-config.json' -or $configName -ceq 'sync-config.v2.json'))) {
            Die 'configName must be sync-config.json or sync-config.v2.json'
        }
    }

    $envProp = $case.PSObject.Properties['env']
    if ($null -ne $envProp) {
        if ($envProp.Value -isnot [pscustomobject]) {
            Die 'env must be an object of strings or null'
        }
        foreach ($p in $envProp.Value.PSObject.Properties) {
            if ($null -ne $p.Value -and $p.Value -isnot [string]) {
                Die 'env must be an object of strings or null'
            }
        }
        if ($null -ne $configV2Prop) {
            $ctxProp = $envProp.Value.PSObject.Properties['CTX_WINDOW_DIR']
            if ($null -ne $ctxProp -and $null -ne $ctxProp.Value) {
                $ctx = [string]$ctxProp.Value
                if ($ctx -cmatch '^(/|[A-Za-z]:|\\)' -or (@($ctx -split '[/\\]') -contains '..')) {
                    Die 'CTX_WINDOW_DIR must be a relative path under home'
                }
            }
        }
    }

    $emptyDirsProp = $case.PSObject.Properties['emptyDirs']
    if ($null -ne $emptyDirsProp) {
        $emptyDirs = $emptyDirsProp.Value
        if ($emptyDirs -isnot [System.Array]) {
            Die 'emptyDirs must be a list of strings'
        }
        foreach ($d in $emptyDirs) {
            if ($d -isnot [string]) {
                Die 'emptyDirs must be a list of strings'
            }
        }
        foreach ($d in $emptyDirs) {
            if ($d -cmatch '^(/|[A-Za-z]:|\\)' -or (@($d -split '[/\\]') -contains '..')) {
                Die 'emptyDirs must be relative paths under home'
            }
        }
    }

    $stubsProp = $case.PSObject.Properties['stubs']
    if ($null -ne $stubsProp) {
        $stubs = $stubsProp.Value
        if ($stubs -isnot [System.Array]) {
            Die 'stubs may only hold gh; dconf, getent and bootstrap are Linux only'
        }
        foreach ($s in $stubs) {
            if (-not ($s -is [string] -and ($s -ceq 'gh' -or $s -ceq 'dconf' -or $s -ceq 'getent' -or $s -ceq 'bootstrap'))) {
                Die 'stubs may only hold gh; dconf, getent and bootstrap are Linux only'
            }
        }
    }

    $syncPointProp = $case.PSObject.Properties['syncPoint']
    if ($null -ne $syncPointProp -and $syncPointProp.Value -isnot [bool]) {
        Die 'syncPoint must be a boolean'
    }
    $hasSyncPoint = $null -ne $syncPointProp
    $hasOrigin = Test-Path -LiteralPath (Join-Path $Dir 'origin') -PathType Container
    if ($hasSyncPoint -or $hasOrigin) {
        $remotes = ($null -ne $gitProp -and $gitProp.Value -is [string] -and $gitProp.Value -ceq 'remote')
        if (-not $remotes) {
            if ($hasSyncPoint) {
                Die 'syncPoint needs git remote'
            }
            Die 'origin/ needs git remote'
        }
    }
    $hasUnsent = Test-Path -LiteralPath (Join-Path $Dir 'unsent') -PathType Container
    if ($hasUnsent) {
        $committed = ($null -ne $gitProp -and $gitProp.Value -is [string] -and ($gitProp.Value -ceq 'committed' -or $gitProp.Value -ceq 'remote'))
        if (-not $committed) {
            Die 'unsent/ needs git committed or remote'
        }
    }

    if ($configV2Prop.Value -isnot [pscustomobject]) {
        Die 'configV2 must be an object'
    }
    # commit reaches gh; only the stub may answer, never a real gh.
    $hasCommit = @($case.commands | Where-Object { $_.command -ceq 'commit' }).Count -gt 0
    $hasGhStub = ($null -ne $stubsProp) -and (@($stubsProp.Value) -ccontains 'gh')
    if ($hasCommit -and -not $hasGhStub) {
        Die 'a commit command needs "stubs": ["gh"]'
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

# expect.<os>\ only applies to a case whose differences name a row the program
# keeps per OS; every other case uses expect\ on every OS.
function Test-ExpectedOsFolder {
    param([string]$Dir)
    $case = $null
    try {
        $case = [IO.File]::ReadAllText((Join-Path $Dir 'case.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
        return $false
    }
    $prop = $case.PSObject.Properties['differences']
    if ($null -eq $prop -or $prop.Value -isnot [System.Array]) {
        return $false
    }
    foreach ($d in $prop.Value) {
        if ($d -is [string] -and ($d -ceq 'Entry selection' -or $d -ceq 'Shared files without rules' -or $d -ceq 'Exclude patterns')) {
            return $true
        }
    }
    return $false
}

# The expected file or tree for $Name: expect.<os>\<Name> when it exists for the
# OS the runner is on, else expect\<Name>.
function Get-ExpectedPath {
    param([string]$Dir, [string]$Name)
    $perOs = Join-Path $Dir ("expect.$HarnessOs\$Name")
    if ((Test-ExpectedOsFolder $Dir) -and (Test-Path -LiteralPath $perOs)) {
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
# checks it"). A line starting `Next` is kept whole, without its indent, for the
# front door's status.
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
        } elseif ($line -cmatch '^\s*(Next.*)$') {
            $result += $Matches[1]
        } elseif ($line -cmatch '^\s*(Linked folder not synced: .*)$') {
            $result += $Matches[1]
        }
    }
    return ,$result
}

# Every line of a command's whole stdout, in order: ANSI color codes removed,
# a trailing carriage return dropped, a final line without a newline kept. An
# empty stdout adds no line (see the README's "How the runner checks it").
# -KeepAnsi keeps the color codes, for statusline.
function Get-WholeOutput {
    param([string]$Raw, [switch]$KeepAnsi)
    $text = $Raw
    if (-not $KeepAnsi) {
        $text = $text -creplace '\x1b\[[0-9;]*[A-Za-z]', ''
    }
    $text = $text -replace "`r`n", "`n"
    $result = @()
    if ($text.Length -eq 0) {
        return ,$result
    }
    if ($text.EndsWith("`n")) {
        $text = $text.Substring(0, $text.Length - 1)
    }
    foreach ($line in ($text -split "`n")) {
        $result += ($line -replace "`r$", '')
    }
    return ,$result
}

# One command's output for the expect/lines.txt check: ANSI color codes
# removed, each line trimmed, and a status line in either engine's layout read
# as `WORD label note` with single spaces between (see the README's "How the
# runner checks it"). Notes and every other line stay as they are, trimmed.
function Get-NormalizedLines {
    param([string]$Raw)
    $text = $Raw -creplace '\x1b\[[0-9;]*[A-Za-z]', ''
    $text = $text -replace "`r`n", "`n"
    $text = $text -replace "`r", "`n"
    $result = @()
    if ($text.Length -eq 0) {
        return ,$result
    }
    if ($text.EndsWith("`n")) {
        $text = $text.Substring(0, $text.Length - 1)
    }
    $patternPs = '^\[\s*(' + $StatusWords + ')\s*\]\s+(\S+)(.*)$'
    $patternBash = '^(' + $StatusWords + ')\s+(\S+)(.*)$'
    foreach ($line in ($text -split "`n")) {
        # A prompt answered from a pipe ends with no newline, so its status line
        # follows it on the same line: drop the `...? [Y/n]` prefix first.
        $line = $line -creplace '^.*\? \[[Yy]/[Nn]\][ \t]*', ''
        $line = $line.Trim()
        if ($line -cmatch $patternPs) {
            $word = $Matches[1]
            $label = $Matches[2]
            $rest = $Matches[3]
        } elseif ($line -cmatch $patternBash) {
            $word = $Matches[1]
            $label = $Matches[2]
            $rest = $Matches[3]
        } else {
            $result += $line
            continue
        }
        $noteMatch = [regex]::Match($rest, '^\s+\((.*)\)\s*$')
        if ($noteMatch.Success) {
            $result += ($word + ' ' + $label + ' ' + $noteMatch.Groups[1].Value)
        } else {
            $result += ($word + ' ' + $label)
        }
    }
    return ,$result
}

# Check expect/lines.txt against the per-command normalized output. Lines
# before any `# <n>` belong to command 1; `# <n>` starts command n's lines.
# Each expected line must appear in that command's output, in the file's order,
# other lines allowed between. `! <text>` means no line of that command's
# output contains <text>. A failure names the first missing (or present `!`)
# line and prints the command's normalized output.
function Compare-LineChecks {
    param([string]$Dir, [object[]]$CommandLines, [int]$CommandCount)
    $wantFile = Get-ExpectedPath $Dir 'lines.txt'
    if (-not (Test-Path -LiteralPath $wantFile -PathType Leaf)) {
        return
    }
    $positions = New-Object int[] $CommandCount
    $cmd = 1
    foreach ($line in (Read-Lines $wantFile)) {
        if ($line -cmatch '^#\s+([0-9]+)$') {
            $cmd = [int]$Matches[1]
            if ($cmd -lt 1 -or $cmd -gt $CommandCount) {
                Die "lines command $cmd`: no such command"
            }
            continue
        }
        $got = @()
        if ($cmd -ge 1 -and $cmd -le $CommandLines.Count) {
            $got = @($CommandLines[$cmd - 1])
        }
        $normalizedOutput = ''
        if ($got.Count -gt 0) {
            $normalizedOutput = ($got -join "`n")
        }
        if ($line.StartsWith('! ')) {
            $text = $line.Substring(2)
            foreach ($g in $got) {
                if ($g.Contains($text)) {
                    Die ("lines command {0}: `"{1}`" must not appear`noutput was:`n{2}" -f $cmd, $text, $normalizedOutput)
                }
            }
        } else {
            $found = $false
            for ($j = $positions[$cmd - 1]; $j -lt $got.Count; $j++) {
                if ($got[$j] -ceq $line) {
                    $positions[$cmd - 1] = $j + 1
                    $found = $true
                    break
                }
            }
            if (-not $found) {
                Die ("lines command {0}: missing `"{1}`"`noutput was:`n{2}" -f $cmd, $line, $normalizedOutput)
            }
        }
    }
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
                # A .git folder, at any depth as with diff -x .git, is not part of the case.
                if ($item.PSIsContainer -and $item.Name -ceq '.git') {
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

# $Rel itself when it is a file or an empty folder, else the first file under
# it, so a message names what the engine actually wrote.
function Get-FirstFileUnder {
    param([string]$Root, [string]$Rel)
    $full = Join-Path $Root ($Rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        return $Rel
    }
    $first = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($first.Count -eq 0) {
        return $Rel
    }
    $sub = $first[0].FullName.Substring($full.Length).TrimStart('\', '/') -replace '\\', '/'
    return "$Rel/$sub"
}

# Compare the wanted and got trees: the file and folder path set must match,
# then every file must match by SHA256. No mode compare. The first difference
# names the file from the case's point of view.
function Compare-Trees {
    param([string]$WantDir, [string]$GotDir, [string]$Name)
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
            Die ("${Name}: only in want: " + (Get-FirstFileUnder $WantDir $wantSorted[$wi]))
        } elseif ($cmp -gt 0) {
            Die ("${Name}: only in got: " + (Get-FirstFileUnder $GotDir $gotSorted[$gi]))
        } else {
            $rel = $wantSorted[$wi]
            $wantFull = Join-Path $WantDir ($rel -replace '/', '\')
            $gotFull = Join-Path $GotDir ($rel -replace '/', '\')
            if (Test-Path -LiteralPath $wantFull -PathType Leaf) {
                $wantHash = (Get-FileHash -LiteralPath $wantFull -Algorithm SHA256).Hash
                $gotHash = (Get-FileHash -LiteralPath $gotFull -Algorithm SHA256).Hash
                if ($wantHash -cne $gotHash) {
                    Die "${Name}: differs: $rel"
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
# Windows can hold a just-run mksync.exe open for a moment after the process
# exits (an antivirus scan, a handle not yet closed), so a delete is retried
# for a few seconds before the case fails.
function Remove-Engine {
    param([string]$RepoDir)
    foreach ($rel in @('mksync.exe', 'sync-config.json', 'sync-config.v2.json', '.user-values.json', 'scripts\ci')) {
        $path = Join-Path $RepoDir $rel
        for ($try = 1; (Test-Path -LiteralPath $path) -and $try -le 40; $try++) {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $path) {
                Start-Sleep -Milliseconds 250
            }
        }
        if (Test-Path -LiteralPath $path) {
            Die "engine file still locked after 10 s: $rel"
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
    $obj = [IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
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

# The full SHA at HEAD of $RepoDir, with the user's own configuration kept out.
function Get-GitHead {
    param([string]$RepoDir)
    $oldGlobal = $env:GIT_CONFIG_GLOBAL
    $oldNoSystem = $env:GIT_CONFIG_NOSYSTEM
    $oldPreference = $ErrorActionPreference
    try {
        $env:GIT_CONFIG_GLOBAL = 'NUL'
        $env:GIT_CONFIG_NOSYSTEM = '1'
        $ErrorActionPreference = 'Continue'
        $head = @(& git -C $RepoDir rev-parse HEAD 2> $null)
        if ($LASTEXITCODE -ne 0) {
            Die 'git rev-parse HEAD failed'
        }
    } finally {
        $ErrorActionPreference = $oldPreference
        $env:GIT_CONFIG_GLOBAL = $oldGlobal
        $env:GIT_CONFIG_NOSYSTEM = $oldNoSystem
    }
    return [string]$head[0]
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

# The gh stub as a program: it appends its arguments joined by spaces, one call
# per line, to gh.log one folder above its own, prints nothing and exits 0.
# The program runs only .com and .exe commands on Windows (contract "The
# program"), so it needs this one. Built once per run with the C# compiler
# Windows PowerShell already carries.
$ghExeTemplate = ''
$ghStubSource = @'
using System;
using System.IO;
using System.Reflection;

public static class GhStub
{
    public static int Main(string[] args)
    {
        string bin = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string log = Path.Combine(Path.GetDirectoryName(bin), "gh.log");
        File.AppendAllText(log, string.Join(" ", args) + "\r\n");
        return 0;
    }
}
'@

# Write the gh stub into <temp>\bin: a gh.exe that appends a call's arguments,
# one call per line, to <temp>\gh.log, prints nothing and exits 0.
function Write-GhStub {
    param([string]$TempDir)
    $binDir = Join-Path $TempDir 'bin'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    if ($script:ghExeTemplate -eq '') {
        $folder = Join-Path ([IO.Path]::GetTempPath()) ('mksync-ghstub-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        $exe = Join-Path $folder 'gh.exe'
        Add-Type -TypeDefinition $ghStubSource -OutputAssembly $exe -OutputType ConsoleApplication
        $script:ghExeTemplate = $exe
    }
    Copy-Item -LiteralPath $script:ghExeTemplate -Destination (Join-Path $binDir 'gh.exe')
}

# The local state the program writes must be readable by the user only on
# Windows: no inherited access rules and exactly one rule, the current user.
# This replaces the Pester cases values-private-new, values-private-tightened and
# values-private-no-domain (tests/windows/Engine.Tests.ps1). Only files the
# program wrote during the case are checked; a seeded file the program left
# alone still carries the runner's own ACL, and the last sync point is no secret.
function Test-PrivateFiles {
    param([string]$RepoDir, [string]$LocalDir, [DateTime]$RunStartUtc)

    $candidates = New-Object System.Collections.Generic.List[object]
    $candidates.Add(@{ Path = (Join-Path $RepoDir '.user-values.json'); Name = '.user-values.json' })
    $stateRoot = Join-Path $LocalDir 'SyncSettings'
    $candidates.Add(@{ Path = (Join-Path $stateRoot 'machine.json'); Name = 'SyncSettings\machine.json' })
    $profilesDir = Join-Path $stateRoot 'profiles'
    if (Test-Path -LiteralPath $profilesDir -PathType Container) {
        foreach ($profileFile in @(Get-ChildItem -LiteralPath $profilesDir -Filter '*.json' -File -Force | Sort-Object Name)) {
            $candidates.Add(@{ Path = $profileFile.FullName; Name = ('SyncSettings\profiles\' + $profileFile.Name) })
        }
    }

    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($candidate in $candidates) {
        $file = $candidate.Path
        $name = $candidate.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            continue
        }
        if ((Get-Item -LiteralPath $file).LastWriteTimeUtc -lt $RunStartUtc) {
            continue
        }
        $acl = Get-Acl -LiteralPath $file
        if (-not $acl.AreAccessRulesProtected) {
            Die "acl: $name inherits access"
        }
        $sids = @($acl.Access | ForEach-Object {
            $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        })
        if ($sids.Count -ne 1 -or $sids[0] -cne $currentSid) {
            $found = @($acl.Access | ForEach-Object {
                '{0} {1} {2} inherited={3}' -f $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value, $_.AccessControlType, $_.FileSystemRights, $_.IsInherited
            }) -join '; '
            Die "acl: $name is not private to the current user ($currentSid); owner $($acl.Owner); rules: $found"
        }
    }
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

        # Program files (scripts\ci too: later cases need leak-scan).
        Copy-Item -LiteralPath $EnginePath -Destination (Join-Path $repoDir 'mksync.exe') -Force
        # The program runs the leak scan from the repo, as run.sh copies it.
        New-Item -ItemType Directory -Path (Join-Path $repoDir 'scripts') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $Repo 'scripts\ci') -Destination (Join-Path $repoDir 'scripts\ci') -Recurse -Force

        # Config and values
        $configJson = $Case.configV2 | ConvertTo-Json -Depth 32 -Compress
        $configName = 'sync-config.json'
        $configNameProp = $Case.PSObject.Properties['configName']
        if ($null -ne $configNameProp) {
            $configName = [string]$configNameProp.Value
        }
        [IO.File]::WriteAllText((Join-Path $repoDir $configName), $configJson, [System.Text.UTF8Encoding]::new($false))

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
            # Copy-Item keeps the fixtures' mtimes, so a home file and its repo
            # twin of the same size can share one; git's stat cache then reports
            # the changed repo file as clean.
            $now = Get-Date
            foreach ($homeFile in @(Get-ChildItem -LiteralPath $homeDir -Recurse -File -Force)) {
                $homeFile.LastWriteTime = $now
            }
        }
        # Git stores no empty folder, so a case names its empty folders in
        # emptyDirs; each is created in the temp home before the first command.
        $emptyDirsProp = $Case.PSObject.Properties['emptyDirs']
        if ($null -ne $emptyDirsProp) {
            foreach ($rel in @($emptyDirsProp.Value)) {
                New-Item -ItemType Directory -Path (Join-Path $homeDir ([string]$rel)) -Force | Out-Null
            }
        }

        # Git: everything committed on master, and for `remote` also a bare
        # origin the repo was pushed to.
        $gitMode = 'none'
        $gitProp = $Case.PSObject.Properties['git']
        if ($null -ne $gitProp) {
            $gitMode = [string]$gitProp.Value
        }
        $startHead = ''
        if ($gitMode -ceq 'committed' -or $gitMode -ceq 'remote') {
            Setup-Git -RepoDir $repoDir -TempDir $t -Mode $gitMode
            # The commit the case starts from: a sync point and an expected
            # state file's <START_HEAD> both name it.
            $startHead = Get-GitHead -RepoDir $repoDir
        }

        # A sync point is the commit the last sync left on master, as the engine
        # records it. It goes in before the case's state/ copy, so a case can
        # override it there.
        $syncPointProp = $Case.PSObject.Properties['syncPoint']
        if ($null -ne $syncPointProp -and $syncPointProp.Value -eq $true) {
            $stateRoot = Join-Path $localDir 'SyncSettings'
            New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $stateRoot 'last-sync'), ($startHead + "`n"),
                [System.Text.UTF8Encoding]::new($false))
        }

        # An origin/ tree is one commit on top of master, made in a second clone
        # and pushed to the bare origin: origin/master is ahead, the repo's
        # master and working tree are not.
        if (Test-Path -LiteralPath (Join-Path $Dir 'origin') -PathType Container) {
            $cloneDir = Join-Path $t 'origin-clone'
            Invoke-Git -What 'git clone of origin' -GitArgs @('clone', '-q', (Join-Path $t 'origin.git'), $cloneDir)
            Copy-Tree (Join-Path $Dir 'origin') $cloneDir
            Invoke-Git -What 'git add in the origin clone' -GitArgs @('-C', $cloneDir, 'add', '-A')
            Invoke-Git -What 'git commit in the origin clone' -GitArgs @('-c', 'user.name=parity', '-c', 'user.email=parity@example.com', '-C', $cloneDir, 'commit', '-q', '-m', 'origin')
            Invoke-Git -What 'git push to origin' -GitArgs @('-C', $cloneDir, 'push', '-q', 'origin', 'master')
            Remove-Item -LiteralPath $cloneDir -Recurse -Force
            Invoke-Git -What 'git fetch origin' -GitArgs @('-C', $repoDir, 'fetch', '-q', 'origin')
        }

        # An unsent/ tree goes over the repo's working tree after the commit and
        # stays uncommitted, so `git status --porcelain` shows it. The copies
        # get a new write time: Copy-Item keeps the source's, and a same-size
        # edit with the committed file's time would pass git's stat check as
        # unchanged on some runs.
        $unsentDir = Join-Path $Dir 'unsent'
        if (Test-Path -LiteralPath $unsentDir -PathType Container) {
            Copy-Tree $unsentDir $repoDir
            $unsentRoot = (Resolve-Path -LiteralPath $unsentDir).Path
            $now = Get-Date
            foreach ($item in @(Get-ChildItem -LiteralPath $unsentRoot -Recurse -File -Force)) {
                $rel = $item.FullName.Substring($unsentRoot.Length).TrimStart('\', '/')
                (Get-Item -LiteralPath (Join-Path $repoDir $rel) -Force).LastWriteTime = $now
            }
        }

        # A seeded state/ goes into the folder the engine treats as its own
        # state, before the first command, exactly like the engine's own files.
        if (Test-Path -LiteralPath (Join-Path $Dir 'state') -PathType Container) {
            Copy-Tree (Join-Path $Dir 'state') (Join-Path $localDir 'SyncSettings')
        }

        # gh stub: first on PATH for every command, logging each call's args.
        $ghStub = $false
        $stubsProp = $Case.PSObject.Properties['stubs']
        if ($null -ne $stubsProp -and (@($stubsProp.Value) -ccontains 'gh')) {
            $ghStub = $true
            Write-GhStub -TempDir $t
        }

        # Optional case env: a string sets the variable, null unsets it. Applied
        # after HOME/USERPROFILE, so a case can unset them too.
        $envNames = New-Object System.Collections.Generic.List[string]
        $envValues = New-Object System.Collections.Generic.List[string]
        $envSet = New-Object System.Collections.Generic.List[bool]
        $caseEnvProp = $Case.PSObject.Properties['env']
        if ($null -ne $caseEnvProp) {
            foreach ($p in $caseEnvProp.Value.PSObject.Properties) {
                $envNames.Add($p.Name)
                if ($null -eq $p.Value) {
                    $envSet.Add($false)
                    $envValues.Add('')
                } else {
                    $envSet.Add($true)
                    # CTX_WINDOW_DIR is relative to the case's temp home.
                    if ($p.Name -ceq 'CTX_WINDOW_DIR') {
                        $envValues.Add((Join-Path $homeDir ([string]$p.Value)))
                    } else {
                        $envValues.Add([string]$p.Value)
                    }
                }
            }
        }

        # Every file the program writes has a LastWriteTimeUtc at or after this
        # point; the seeding above is older, so Test-PrivateFiles skips it.
        $runStartUtc = [DateTime]::UtcNow

        # Commands
        $commands = $Case.commands
        $exitCodes = New-Object System.Collections.Generic.List[string]
        $statusOut = New-Object System.Collections.Generic.List[string]
        $lineOutputs = New-Object System.Collections.Generic.List[object]
        $wholeRanges = New-Object System.Collections.Generic.List[object]

        for ($i = 0; $i -lt $commands.Count; $i++) {
            $cmdObj = $commands[$i]
            $cmd = [string]$cmdObj.command

            $scriptPath = Join-Path $repoDir 'mksync.exe'
            $extraArgs = @()
            $targetProp = $null
            $cmdOptsProp = $cmdObj.PSObject.Properties['options']
            if ($null -ne $cmdOptsProp -and $null -ne $cmdOptsProp.Value) {
                $targetProp = $cmdOptsProp.Value.PSObject.Properties['target']
            }
            switch -CaseSensitive ($cmd) {
                'export'  { $extraArgs += 'export' }
                'import'  { $extraArgs += 'import' }
                'check'   { $extraArgs += 'import'; $extraArgs += '--check' }
                'preview' { $extraArgs += 'export'; $extraArgs += '--preview' }
                'diff'    { $extraArgs += 'export'; $extraArgs += '--diff' }
                'commit'  { $extraArgs += 'commit' }
                'setup'   { $extraArgs += 'setup' }
                'statusline' { $extraArgs += 'statusline' }
                'status'  { $extraArgs += 'status' }
                'doctor'  { $extraArgs += 'doctor' }
                'pull'    { $extraArgs += 'pull' }
                'push'    { $extraArgs += 'push' }
                'front-diff' { $extraArgs += 'diff' }
                'front-check' { $extraArgs += 'check' }
                'front-preview' { $extraArgs += 'preview' }
                'machine-show' { $extraArgs += 'machine'; $extraArgs += 'show' }
                'machine-retire' {
                    $extraArgs += 'machine'
                    $extraArgs += 'retire'
                    $extraArgs += [string]$targetProp.Value
                }
                'profile-retire' {
                    $extraArgs += 'profile'
                    $extraArgs += 'retire'
                    $extraArgs += [string]$targetProp.Value
                }
                default   { Die "unknown command '$cmd' in command $($i + 1)" }
            }

            $optsProp = $cmdObj.PSObject.Properties['options']
            if ($null -ne $optsProp) {
                $opts = $optsProp.Value
                foreach ($key in $opts.PSObject.Properties.Name) {
                    if ($key -cne 'force' -and $key -cne 'only' -and $key -cne 'name' -and
                        $key -cne 'profile' -and $key -cne 'replace' -and $key -cne 'claude' -and
                        $key -cne 'mode' -and $key -cne 'existing' -and $key -cne 'yes' -and
                        $key -cne 'bootstrap' -and
                        $key -cne 'target' -and $key -cne 'partial' -and $key -cne 'message' -and
                        $key -cne 'paths' -and $key -cne 'resetValues') {
                        Die "unknown option '$key' in command $($i + 1)"
                    }
                }
                $forceProp = $opts.PSObject.Properties['force']
                if ($null -ne $forceProp -and $forceProp.Value -eq $true) {
                    $extraArgs += '--force'
                }
                $onlyProp = $opts.PSObject.Properties['only']
                if ($null -ne $onlyProp) {
                    $onlyPaths = @($onlyProp.Value)
                    if ($onlyPaths.Count -gt 0) {
                        foreach ($p in $onlyPaths) {
                            $extraArgs += '--only'
                            $extraArgs += $p
                        }
                    }
                }
                foreach ($key in @('name', 'profile', 'replace', 'claude', 'mode', 'existing')) {
                    $p = $opts.PSObject.Properties[$key]
                    if ($null -ne $p) {
                        $extraArgs += ("--" + $key)
                        $extraArgs += [string]$p.Value
                    }
                }
                $yesProp = $opts.PSObject.Properties['yes']
                if ($null -ne $yesProp -and $yesProp.Value -eq $true) {
                    $extraArgs += '--yes'
                }
                $bootstrapProp = $opts.PSObject.Properties['bootstrap']
                if ($null -ne $bootstrapProp -and $bootstrapProp.Value -eq $true) {
                    $extraArgs += '--bootstrap'
                }
                $partialProp = $opts.PSObject.Properties['partial']
                if ($null -ne $partialProp -and $partialProp.Value -eq $true) {
                    $extraArgs += '--partial'
                }
                $messageProp = $opts.PSObject.Properties['message']
                if ($null -ne $messageProp) {
                    $extraArgs += '-m'
                    $extraArgs += [string]$messageProp.Value
                }
                $resetProp = $opts.PSObject.Properties['resetValues']
                if ($null -ne $resetProp -and $resetProp.Value -eq $true) {
                    $extraArgs += '--reset-values'
                }
                $pathsProp = $opts.PSObject.Properties['paths']
                if ($null -ne $pathsProp) {
                    foreach ($p in @($pathsProp.Value)) {
                        $extraArgs += [string]$p
                    }
                }
            }

            $stdinText = ''
            $stdinProp = $cmdObj.PSObject.Properties['stdin']
            if ($null -ne $stdinProp) {
                $stdinText = [string]$stdinProp.Value
            }

            # With stderr, the command's stderr is kept apart so its lines land
            # in the output after the stdout lines; a whole-stdout command
            # without it also keeps stderr apart, so only stdout reaches the
            # output; otherwise both streams are merged as before.
            $stderrMode = $false
            $stderrProp = $cmdObj.PSObject.Properties['stderr']
            if ($null -ne $stderrProp -and $stderrProp.Value -eq $true) {
                $stderrMode = $true
            }
            $allOutput = ($cmd -ceq 'setup' -or $cmd -ceq 'machine-show' -or
                $cmd -ceq 'machine-retire' -or $cmd -ceq 'profile-retire' -or
                $cmd -ceq 'statusline')
            $keepAnsi = ($cmd -ceq 'statusline')
            if ($null -ne $cmdObj.PSObject.Properties['output']) {
                $allOutput = $true
            }
            $rawErr = Join-Path $t 'raw-err'

            $launch = $scriptPath
            $procArgs = $extraArgs

            $oldProfile = $env:USERPROFILE
            $oldHome = $env:HOME
            $oldLocal = $env:LOCALAPPDATA
            $oldPath = $env:PATH
            $oldGh = $env:GH
            $oldVirtualEnv = $env:VIRTUAL_ENV
            $oldCondaEnv = $env:CONDA_DEFAULT_ENV
            $oldDbus = $env:DBUS_SESSION_BUS_ADDRESS
            $oldGitDir = $env:GIT_DIR
            $oldGitWorkTree = $env:GIT_WORK_TREE
            $oldGitIndexFile = $env:GIT_INDEX_FILE
            $oldGhToken = $env:GH_TOKEN
            $oldGithubToken = $env:GITHUB_TOKEN
            $oldGitCeiling = $env:GIT_CEILING_DIRECTORIES
            $oldPreference = $ErrorActionPreference
            $raw = ''
            $output = @()
            # A name and its value before the command, restored after it: $null
            # marks a variable that was not set.
            $savedEnv = New-Object System.Collections.Generic.List[object]
            Push-Location $repoDir
            try {
                $env:USERPROFILE = $homeDir
                $env:HOME = $homeDir
                $env:LOCALAPPDATA = $localDir
                # GH overrides the gh binary; a caller's GH must never reach a
                # case. VIRTUAL_ENV and CONDA_DEFAULT_ENV would
                # otherwise add a statusline section. A caller's git repo, bus and
                # tokens stay out too, and git may not climb above the case folder;
                # the case's env is applied after, so it may still set them.
                $env:GH = $null
                $env:VIRTUAL_ENV = $null
                $env:CONDA_DEFAULT_ENV = $null
                $env:DBUS_SESSION_BUS_ADDRESS = $null
                $env:GIT_DIR = $null
                $env:GIT_WORK_TREE = $null
                $env:GIT_INDEX_FILE = $null
                $env:GH_TOKEN = $null
                $env:GITHUB_TOKEN = $null
                $env:GIT_CEILING_DIRECTORIES = $t
                if ($ghStub) {
                    $env:PATH = (Join-Path $t 'bin') + ';' + $env:PATH
                    $env:GH = Join-Path $t 'bin\gh.exe'
                }
                # The case's env, applied after HOME/USERPROFILE is set.
                for ($e = 0; $e -lt $envNames.Count; $e++) {
                    $name = $envNames[$e]
                    $savedEnv.Add(@($name, [System.Environment]::GetEnvironmentVariable($name, 'Process')))
                    if ($envSet[$e]) {
                        Set-Item -Path ("Env:" + $name) -Value $envValues[$e]
                    } else {
                        Remove-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue
                    }
                }
                # In PS 5.1 a native command's stderr redirected with 2>&1 turns
                # into error records, which 'Stop' would throw on.
                $ErrorActionPreference = 'Continue'
                if ($stderrMode) {
                    $output = @($stdinText | & $launch @procArgs 2>&1)
                } elseif ($allOutput) {
                    $raw = $stdinText | & $launch @procArgs 2> $rawErr | Out-String
                } else {
                    # Each stderr line is cast to its own text: Out-String would
                    # print an error record's `<exe> : ` prefix and `At …` lines.
                    $merged = @($stdinText | & $launch @procArgs 2>&1)
                    $raw = ''
                    foreach ($item in $merged) {
                        $raw += ([string]$item).TrimEnd("`r") + "`n"
                    }
                }
                $rc = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $oldPreference
                # The case env first: its saved HOME/USERPROFILE are the runner's
                # temporary values, which the assignments below then replace with
                # the ones from before the command.
                for ($e = $savedEnv.Count - 1; $e -ge 0; $e--) {
                    $name = $savedEnv[$e][0]
                    $oldValue = $savedEnv[$e][1]
                    if ($null -eq $oldValue) {
                        Remove-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue
                    } else {
                        Set-Item -Path ("Env:" + $name) -Value $oldValue
                    }
                }
                $env:USERPROFILE = $oldProfile
                $env:HOME = $oldHome
                $env:LOCALAPPDATA = $oldLocal
                $env:PATH = $oldPath
                $env:GH = $oldGh
                $env:VIRTUAL_ENV = $oldVirtualEnv
                $env:CONDA_DEFAULT_ENV = $oldCondaEnv
                $env:DBUS_SESSION_BUS_ADDRESS = $oldDbus
                $env:GIT_DIR = $oldGitDir
                $env:GIT_WORK_TREE = $oldGitWorkTree
                $env:GIT_INDEX_FILE = $oldGitIndexFile
                $env:GH_TOKEN = $oldGhToken
                $env:GITHUB_TOKEN = $oldGithubToken
                $env:GIT_CEILING_DIRECTORIES = $oldGitCeiling
                Pop-Location
            }

            $outStart = $statusOut.Count
            $exitCodes.Add([string]$rc)
            if ($stderrMode) {
                # Stdout lines are the strings; stderr lines arrive as error
                # records and go after the stdout status lines.
                $rawText = ''
                foreach ($item in $output) {
                    if ($item -is [System.Management.Automation.ErrorRecord]) {
                        continue
                    }
                    $rawText += ([string]$item) + "`n"
                }
                if ($allOutput) {
                    foreach ($line in (Get-WholeOutput -Raw $rawText -KeepAnsi:$keepAnsi)) {
                        $statusOut.Add($line)
                    }
                } else {
                    foreach ($line in (Get-StatusLines $rawText)) {
                        $statusOut.Add($line)
                    }
                }
                $rawErrText = ''
                foreach ($item in $output) {
                    if ($item -isnot [System.Management.Automation.ErrorRecord]) {
                        continue
                    }
                    $line = ([string]$item) -creplace '\x1b\[[0-9;]*[A-Za-z]', ''
                    $statusOut.Add($line.TrimEnd("`r"))
                    $rawErrText += $line + "`n"
                }
                # The same command's whole output, normalized for
                # expect/lines.txt: stdout, then stderr as for output.txt.
                $lineOutputs.Add((Get-NormalizedLines -Raw ($rawText + $rawErrText)))
            } elseif ($allOutput) {
                foreach ($line in (Get-WholeOutput -Raw $raw -KeepAnsi:$keepAnsi)) {
                    $statusOut.Add($line)
                }
                $lineOutputs.Add((Get-NormalizedLines -Raw $raw))
            } else {
                foreach ($line in (Get-StatusLines $raw)) {
                    $statusOut.Add($line)
                }
                $lineOutputs.Add((Get-NormalizedLines -Raw $raw))
            }
            if ($allOutput) {
                # The lines this command added, for the placeholder rewrite
                # once every command has run.
                $wholeRanges.Add(@($outStart, $statusOut.Count))
            }
        }

        # Every command has run: the whole-stdout lines can now be compared
        # with the places whose value changes per run replaced (the temp home,
        # the backup run folder, the sync point's sha). The status lines, and
        # every line outside a whole-stdout command, are left alone.
        $rewriteHomes = @()
        $rewriteHomes += $homeDir
        $rewriteHomes += ($homeDir -replace '\\', '/')
        $runName = ''
        $backupsDir = Join-Path (Join-Path $localDir 'SyncSettings') 'backups'
        if (Test-Path -LiteralPath $backupsDir -PathType Container) {
            $backupRuns = @(Get-ChildItem -LiteralPath $backupsDir -Directory -Force)
            if ($backupRuns.Count -eq 1) {
                $runName = [string]$backupRuns[0].Name
            }
        }
        $syncHead = ''
        if ($gitMode -ceq 'committed' -or $gitMode -ceq 'remote') {
            try {
                $syncHead = Get-GitHead -RepoDir $repoDir
            } catch {
                $syncHead = ''
            }
        }
        foreach ($range in $wholeRanges) {
            for ($n = [int]$range[0]; $n -lt [int]$range[1]; $n++) {
                $line = $statusOut[$n]
                foreach ($homeForm in $rewriteHomes) {
                    $line = $line -creplace [regex]::Escape($homeForm), '<HOME>'
                }
                if ($runName -ne '') {
                    $line = $line -creplace [regex]::Escape('backups\' + $runName), 'backups/RUN'
                    $line = $line -creplace [regex]::Escape('backups/' + $runName), 'backups/RUN'
                }
                if ($syncHead -ne '') {
                    $point = [regex]::Match($line, '^  Sync point : ([0-9a-fA-F]+)$')
                    if ($point.Success -and $syncHead.StartsWith($point.Groups[1].Value, [System.StringComparison]::Ordinal)) {
                        $line = '  Sync point : <HEAD>'
                    }
                }
                $statusOut[$n] = $line
            }
        }

        Test-PrivateFiles -RepoDir $repoDir -LocalDir $localDir -RunStartUtc $runStartUtc

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
                # <START_HEAD> stands for the commit the case started from,
                # which changes per run; substitute it before comparing.
                $wantHashFile = $wantFile
                $wantText = [IO.File]::ReadAllText($wantFile)
                if ($wantText.Contains('<START_HEAD>')) {
                    if ([string]::IsNullOrEmpty($startHead)) {
                        Die "state ${rel}: <START_HEAD> needs a git repo"
                    }
                    $wantText = $wantText.Replace('<START_HEAD>', $startHead)
                    $wantHashFile = Join-Path $t ([Guid]::NewGuid().ToString('N'))
                    [IO.File]::WriteAllText($wantHashFile, $wantText, [System.Text.UTF8Encoding]::new($false))
                }
                $wantHash = (Get-FileHash -LiteralPath $wantHashFile -Algorithm SHA256).Hash
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
        Compare-LineChecks -Dir $Dir -CommandLines $lineOutputs.ToArray() -CommandCount $commands.Count

        # powershell.exe started with a temp USERPROFILE leaves empty AppData
        # folders behind. Drop them only when no file is under them, so a file
        # the engine writes there still shows in the compare.
        $appData = Join-Path $homeDir 'AppData'
        if (Test-Path -LiteralPath $appData -PathType Container) {
            $appFiles = @(Get-ChildItem -LiteralPath $appData -Recurse -File -Force -ErrorAction SilentlyContinue)
            if ($appFiles.Count -eq 0) {
                Remove-Item -LiteralPath $appData -Recurse -Force
            }
        }

        # Home tree: an absent expect home means the tree must be empty.
        $wantHome = Get-ExpectedPath $Dir 'home'
        $homeWantDir = $emptyDir
        if (Test-Path -LiteralPath $wantHome -PathType Container) {
            $homeWantDir = $wantHome
        }
        # Git stores no empty folder, so expect\home can't hold the ones
        # emptyDirs makes; the compare sees a copy of it that has them.
        $emptyDirsProp = $Case.PSObject.Properties['emptyDirs']
        if ($null -ne $emptyDirsProp) {
            $wantCopy = Join-Path $t 'expect\home'
            New-Item -ItemType Directory -Path $wantCopy -Force | Out-Null
            Copy-Tree $homeWantDir $wantCopy
            foreach ($rel in @($emptyDirsProp.Value)) {
                New-Item -ItemType Directory -Path (Join-Path $wantCopy ([string]$rel)) -Force | Out-Null
            }
            $homeWantDir = $wantCopy
        }
        Compare-Trees $homeWantDir $homeDir 'home'

        # Repo tree, after the engine files are stripped. An absent expect repo
        # means the tree must be empty.
        Remove-Engine $repoDir
        $wantRepo = Get-ExpectedPath $Dir 'repo'
        $repoWantDir = $emptyDir
        if (Test-Path -LiteralPath $wantRepo -PathType Container) {
            $repoWantDir = $wantRepo
        }
        Compare-Trees $repoWantDir $repoDir 'repo'
    } finally {
        Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# -- Runner --------------------------------------------------------------------

$caseDirs = @(Get-ChildItem -LiteralPath $Cases -Directory -ErrorAction SilentlyContinue | Sort-Object Name)

foreach ($caseDir in $caseDirs) {
    $dir = $caseDir.FullName
    $caseName = $caseDir.Name

    if ($Filter -ne '' -and $caseName.IndexOf($Filter, [StringComparison]::Ordinal) -lt 0) {
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

    # import-eof-no-force counts as yes on every OS.
    if ($caseName -cne 'import-eof-no-force') {
        $osProp = $case.PSObject.Properties['os']
        if ($null -ne $osProp) {
            if (-not (@($osProp.Value) -ccontains 'windows')) {
                Write-Output "skip $caseName"
                continue
            }
        }
    }

    # dconf, getent and bootstrap are Linux stubs: a case whose os list still reaches
    # Windows with one is invalid, not skipped.
    $linuxStub = $null
    $stubsProp = $case.PSObject.Properties['stubs']
    if ($null -ne $stubsProp) {
        foreach ($s in @($stubsProp.Value)) {
            if ($s -is [string] -and ($s -ceq 'dconf' -or $s -ceq 'getent' -or $s -ceq 'bootstrap')) {
                $linuxStub = $s
                break
            }
        }
    }
    if ($null -ne $linuxStub) {
        Write-Output "FAIL ${caseName}: the $linuxStub stub is Linux only: run this case with tests/parity/run.sh"
        $failed++
        continue
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

if ($ghExeTemplate -ne '') {
    Remove-Item -LiteralPath (Split-Path -Parent $ghExeTemplate) -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed -gt 0) {
    exit 1
}
