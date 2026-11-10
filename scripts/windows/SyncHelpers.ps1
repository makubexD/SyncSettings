#Requires -Version 5.1
<#
.SYNOPSIS
    Shared helper functions for SyncSettings scripts.
.DESCRIPTION
    Dot-source this file at the top of each script:
        . "$PSScriptRoot\SyncHelpers.ps1"
#>

# -- User profile resolution --------------------------------------------------

function Resolve-UserProfile {
    param([string]$Username)
    if ($Username -eq $env:USERNAME) { return $env:USERPROFILE }
    $path = Join-Path 'C:\Users' $Username
    if (Test-Path $path) { return $path }
    try {
        $sid = (New-Object System.Security.Principal.NTAccount($Username)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
        $reg = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
        if (Test-Path $reg) { return (Get-ItemProperty $reg).ProfileImagePath }
    } catch {}
    throw "Cannot resolve profile directory for user '$Username'. Make sure the user exists and has logged in at least once."
}

function Test-WindowsEntry {
    # Only entries whose platform selects Windows belong to the PowerShell
    # scripts: "windows", "common", or a list holding "windows". "linux" and
    # "macos" entries belong to the bash scripts; anything else is caught by
    # Assert-ValidPlatform.
    param($Entry)
    $platform = $Entry.platform
    if ($platform -is [array]) { return ($platform -ccontains 'windows') }
    return ($platform -ceq 'windows') -or ($platform -ceq 'common')
}

function Assert-ValidPlatform {
    <#
    .SYNOPSIS
        Stops the run if any entry has a missing or invalid platform.
    .DESCRIPTION
        Every entry must name one of "common", "windows", "linux" or "macos",
        or a non-empty list of the last three without repeats. The check covers
        all entries, not only the ones this engine selects, so a bad Linux
        entry also stops the Windows engine.
    #>
    param([array]$Files)
    foreach ($entry in $Files) {
        $prop  = $entry.PSObject.Properties['platform']
        $valid = $false
        if ($null -ne $prop) {
            $value = $prop.Value
            if ($value -is [array]) {
                # Never compare an array with -eq/-ne: that filters in PowerShell.
                $valid = ($value.Count -gt 0)
                $seen  = @()
                foreach ($item in $value) {
                    if (-not ($item -is [string]) -or
                        ($item -cne 'windows' -and $item -cne 'linux' -and $item -cne 'macos') -or
                        ($seen -ccontains $item)) {
                        $valid = $false
                        break
                    }
                    $seen += $item
                }
            } elseif ($value -is [string]) {
                $valid = ($value -ceq 'common' -or $value -ceq 'windows' -or
                          $value -ceq 'linux' -or $value -ceq 'macos')
            }
        }
        if (-not $valid) {
            throw ('sync-config.json: entry {0} needs "platform": "common", "windows", "linux", "macos" or a list of the last three.' -f $entry.repoPath)
        }
    }
}

function Select-WindowsEntries {
    <#
    .SYNOPSIS
        The entries this engine runs, with localPaths.windows applied.
    .DESCRIPTION
        Keeps the entries Test-WindowsEntry selects. An entry with a
        localPaths.windows value gets that value as its localPath in the copy
        returned here; sync-config.json itself is never written back.
    #>
    param([array]$Files)
    $selected = @()
    foreach ($entry in $Files) {
        if (-not (Test-WindowsEntry $entry)) { continue }
        $chosen = $entry
        if ($entry.PSObject.Properties['localPaths']) {
            $localPaths = $entry.localPaths
            if ($localPaths -is [System.Management.Automation.PSCustomObject]) {
                $windows = $localPaths.PSObject.Properties['windows']
                if ($null -ne $windows -and $null -ne $windows.Value) {
                    $chosen = $entry.PSObject.Copy()
                    $chosen.localPath = [string]$windows.Value
                }
            }
        }
        $selected += $chosen
    }
    return $selected
}

function Test-SafePath {
    <#
    .SYNOPSIS
        True when a repoPath or localPath stays inside its allowed area.
    .DESCRIPTION
        repoPath must start with dotfiles/ and localPath with ~/ or ~\, both
        with no .. segment, splitting on both / and \. A name like foo..bar is
        a legal segment; an empty or missing path never matches a prefix, so it
        fails.
    #>
    param([string]$Path, [string]$Kind)

    if ([string]::IsNullOrEmpty($Path)) { return $false }

    if ($Kind -eq 'repo') {
        if ($Path -cnotlike 'dotfiles/*') { return $false }
    } else {
        if ($Path -cnotlike '~/*' -and $Path -cnotlike '~\*') { return $false }
    }

    foreach ($seg in ($Path -split '[/\\]')) {
        if ($seg -eq '..') { return $false }
    }
    return $true
}

function Get-OwningRepoPath {
    # The repoPath of the entry that owns a repo-relative path, or the path
    # itself when no entry does. A file entry owns its repoPath exactly; a dir
    # entry owns everything under <repoPath>/; an entry with detectLinkedPaths
    # owns everything under <repoPath>.linked/.
    param([array]$Files, [string]$RelPath)

    foreach ($entry in $Files) {
        if (-not ($entry.PSObject.Properties['type'] -and $entry.type -eq 'dir')) {
            if ([string]$entry.repoPath -eq $RelPath) { return [string]$entry.repoPath }
        }
    }
    foreach ($entry in $Files) {
        if ($entry.PSObject.Properties['type'] -and $entry.type -eq 'dir') {
            $r = [string]$entry.repoPath
            if ($RelPath -eq $r -or $RelPath.StartsWith("$r/", [StringComparison]::Ordinal)) {
                return $r
            }
        }
    }
    foreach ($entry in $Files) {
        if ($entry.PSObject.Properties['detectLinkedPaths'] -and $entry.detectLinkedPaths -eq $true) {
            $r = [string]$entry.repoPath
            if ($RelPath.StartsWith("$r.linked/", [StringComparison]::Ordinal)) {
                return $r
            }
        }
    }
    return $RelPath
}

function Assert-SafePaths {
    <#
    .SYNOPSIS
        Stops the run if any entry has an unsafe path or dotfiles/ holds a
        reparse point.
    .DESCRIPTION
        Every entry's repoPath must start with dotfiles/ and its localPath with
        ~/ or ~\, both with no .. segment. Each localPaths value follows the
        localPath rule, and its keys are linux, macos or windows. A reparse
        point (symlink or junction) anywhere under dotfiles/ also stops the run.
        The checks cover all entries, not only the ones this engine selects.
    #>
    param([string]$RepoRoot, [array]$Files)

    foreach ($entry in $Files) {
        $repoPath  = [string]$entry.repoPath
        $localPath = [string]$entry.localPath
        if (-not (Test-SafePath -Path $repoPath -Kind repo)) {
            throw ('sync-config.json: entry {0} has an unsafe path.' -f $repoPath)
        }
        # localPaths is an optional object of per-system paths. A value follows
        # the localPath rule, and a key names a system the engine knows.
        if ($entry.PSObject.Properties['localPaths']) {
            $localPaths = $entry.localPaths
            if (-not ($localPaths -is [System.Management.Automation.PSCustomObject])) {
                throw ('sync-config.json: entry {0} has an unsafe path.' -f $repoPath)
            }
            foreach ($lp in $localPaths.PSObject.Properties) {
                if ($lp.Name -cne 'linux' -and $lp.Name -cne 'macos' -and $lp.Name -cne 'windows') {
                    throw ('sync-config.json: entry {0} has an unknown localPaths key {1}.' -f $repoPath, $lp.Name)
                }
                if (-not (Test-SafePath -Path ([string]$lp.Value) -Kind local)) {
                    throw ('sync-config.json: entry {0} has an unsafe path.' -f $repoPath)
                }
            }
        }
        # A dconf entry has no local file: it owns its repoPath and names a dconf
        # folder instead. Refuse a bad one before anything is dumped or loaded.
        if ($entry.PSObject.Properties['type'] -and $entry.type -ceq 'dconf') {
            $dconfPath = [string]$entry.path
            $platform  = [string]$entry.platform
            $valid = (-not ($entry.platform -is [array])) -and
                ($platform -ceq 'linux') -and
                ($dconfPath -cmatch '^(/[A-Za-z0-9._-]+)+/$') -and
                ($dconfPath -cnotlike '*/../*')
            if (-not $valid) {
                throw ('sync-config.json: entry {0} needs "platform": "linux" and a dconf path like /org/gnome/shell/.' -f $repoPath)
            }
        } elseif (-not (Test-SafePath -Path $localPath -Kind local)) {
            throw ('sync-config.json: entry {0} has an unsafe path.' -f $repoPath)
        }
    }

    # A reparse point can point anywhere; name the entry that owns it, or the
    # reparse point's own repo-relative path when no entry does.
    $base         = $RepoRoot.TrimEnd('\', '/')
    $dotfilesRoot = Join-Path $base 'dotfiles'
    if (Test-Path -LiteralPath $dotfilesRoot -PathType Container) {
        $stack = New-Object System.Collections.Stack
        $stack.Push($dotfilesRoot)
        while ($stack.Count -gt 0) {
            $dir = $stack.Pop()
            foreach ($item in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    $rel = ($item.FullName.Substring($base.Length).TrimStart('\', '/')) -replace '\\', '/'
                    throw ('sync-config.json: entry {0} has an unsafe path.' -f (Get-OwningRepoPath -Files $Files -RelPath $rel))
                } elseif ($item.PSIsContainer) {
                    $stack.Push($item.FullName)
                }
            }
        }
    }
}

function Resolve-LocalPath {
    param([string]$Template, [string]$ProfileRoot)
    # "~/..." works on both engines: expand ~ first, then use backslashes on Windows.
    $path = $Template -replace '^~', $ProfileRoot
    return $path -replace '/', '\'
}

# -- Picking files (-Only) ----------------------------------------------------

function Resolve-OnlyPaths {
    <#
    .SYNOPSIS
        Turns repo or local paths into the repo paths this OS's entries own.
    .DESCRIPTION
        Mirrors resolve_only in scripts/linux/sync.sh. A path that starts with
        dotfiles/ (or dotfiles\) is a repo path, compared ordinally with each
        entry's repoPath, or a file under a dir entry or a file entry's .linked/
        folder. Anything else is a local path: ~\ and ~/ become UserProfile, a
        relative path joins $env:SYNC_CALLER_PWD (or the current folder), then
        the path is normalized and compared case-insensitively with each entry's
        resolved localPath. A path that matches no entry throws, so the caller
        exits 1 before any file is touched.
    #>
    param(
        [string[]]$Paths,
        [array]$Files,
        [string]$UserProfile
    )

    if ($null -eq $Paths -or $Paths.Count -eq 0) { return @() }

    # Resolve each entry once: its repoPath, its kind, and its normalized local
    # path (empty for dconf, which has no local file and matches by repo only).
    $entries = @()
    foreach ($entry in $Files) {
        $repoPath = [string]$entry.repoPath
        $kind = 'file'
        if ($entry.PSObject.Properties['type'] -and $entry.type) {
            if ([string]$entry.type -ceq 'dir') { $kind = 'dir' }
            elseif ([string]$entry.type -ceq 'dconf') { $kind = 'dconf' }
        }
        $localPath = ''
        if ($kind -cne 'dconf') {
            $localPath = [IO.Path]::GetFullPath((Resolve-LocalPath -Template ([string]$entry.localPath) -ProfileRoot $UserProfile))
        }
        $entries += [PSCustomObject]@{ repoPath = $repoPath; kind = $kind; localPath = $localPath }
    }

    $selected = @()
    foreach ($arg in $Paths) {
        $p = [string]$arg

        # Drop trailing separators, as resolve_only drops trailing slashes.
        while ($p.Length -gt 3 -and ($p.EndsWith('\') -or $p.EndsWith('/'))) {
            $p = $p.Substring(0, $p.Length - 1)
        }

        if ($p.StartsWith('dotfiles/', [StringComparison]::Ordinal) -or
            $p.StartsWith('dotfiles\', [StringComparison]::Ordinal)) {
            $p = $p -replace '\\', '/'
            foreach ($seg in ($p -split '/')) {
                if ($seg -ceq '..') {
                    throw ('{0} is not synced on this machine.' -f $arg)
                }
            }
            $found = $false
            foreach ($e in $entries) {
                if ([string]::Equals($p, $e.repoPath, [StringComparison]::Ordinal)) {
                    $found = $true
                } elseif ($e.kind -ceq 'dir' -and $p.StartsWith($e.repoPath + '/', [StringComparison]::Ordinal)) {
                    $found = $true
                } elseif ($e.kind -ceq 'file' -and $p.StartsWith($e.repoPath + '.linked/', [StringComparison]::Ordinal)) {
                    $found = $true
                }
                if ($found) { break }
            }
            if (-not $found) {
                throw ('{0} is not synced on this machine.' -f $arg)
            }
            $selected += $p
            continue
        }

        # Local path: expand ~, make it absolute against the caller's folder,
        # then normalize . and .. so it compares with the entries' paths.
        if ($p -ceq '~') {
            $p = $UserProfile
        } elseif ($p.StartsWith('~/') -or $p.StartsWith('~\')) {
            if ($p.Length -gt 2) {
                $p = $UserProfile.TrimEnd('\') + '\' + $p.Substring(2)
            } else {
                $p = $UserProfile.TrimEnd('\')
            }
        }
        if (-not [IO.Path]::IsPathRooted($p)) {
            $caller = $env:SYNC_CALLER_PWD
            if ([string]::IsNullOrEmpty($caller)) { $caller = (Get-Location).Path }
            $p = Join-Path $caller $p
        }
        $p = [IO.Path]::GetFullPath($p)

        $found = $false
        foreach ($e in $entries) {
            if ($e.kind -cne 'dconf' -and [string]::Equals($p, $e.localPath, [StringComparison]::OrdinalIgnoreCase)) {
                $selected += $e.repoPath
                $found = $true
                break
            }
        }
        if (-not $found) {
            foreach ($e in $entries) {
                if ($e.kind -ceq 'dir' -and $p.StartsWith($e.localPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    $rest = $p.Substring($e.localPath.Length + 1) -replace '\\', '/'
                    $selected += ($e.repoPath + '/' + $rest)
                    $found = $true
                    break
                }
            }
        }
        if (-not $found) {
            throw ('{0} is not synced on this machine.' -f $arg)
        }
    }

    return $selected
}

function Test-OnlySelected {
    <#
    .SYNOPSIS
        True when a single repo path (a file) is picked by the -Only selection.
    .DESCRIPTION
        Mirrors only_selected in scripts/linux/sync.sh: with no selection every
        path is picked; otherwise the path equals a selected path, or lies under
        one (including its .linked/ folder). Comparisons are ordinal
        (case-sensitive), like the Linux version.
    #>
    param([string]$RepoPath, [string[]]$Selected)

    if ($null -eq $Selected -or $Selected.Count -eq 0) { return $true }

    foreach ($sel in $Selected) {
        if ($null -eq $sel) { continue }
        if ([string]::Equals($RepoPath, $sel, [StringComparison]::Ordinal)) { return $true }
        if ($RepoPath.StartsWith($sel + '/', [StringComparison]::Ordinal)) { return $true }
        if ($RepoPath.StartsWith($sel + '.linked/', [StringComparison]::Ordinal)) { return $true }
    }
    return $false
}

function Test-OnlyEntrySelected {
    <#
    .SYNOPSIS
        True when a config entry can contribute files under the -Only selection.
    .DESCRIPTION
        Mirrors entry_selected in scripts/linux/sync.sh: an entry is selected
        when its own path is picked (Test-OnlySelected), or a selected path lies
        under the entry's own path or its .linked/ folder. With no selection
        every entry is selected.
    #>
    param([string]$RepoPath, [string[]]$Selected)

    if (Test-OnlySelected -RepoPath $RepoPath -Selected $Selected) { return $true }

    foreach ($sel in $Selected) {
        if ($null -eq $sel) { continue }
        if ($sel.StartsWith($RepoPath + '/', [StringComparison]::Ordinal)) { return $true }
        if ($sel.StartsWith($RepoPath + '.linked/', [StringComparison]::Ordinal)) { return $true }
    }
    return $false
}

# -- Exclude pattern check ----------------------------------------------------

function Test-Excluded {
    param([string]$FilePath, [string[]]$Patterns)
    $leaf = Split-Path $FilePath -Leaf
    foreach ($p in $Patterns) {
        if ($leaf -like $p -or $FilePath -like "*\$p") { return $true }
    }
    return $false
}

# -- Admin check --------------------------------------------------------------

function Test-IsAdmin {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# -- Terminal check ------------------------------------------------------------

function Test-Interactive {
    # True when a human can answer a prompt; the up-to-date check (step 18) reuses it.
    return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected)
}

# -- Up-to-date check ----------------------------------------------------------

function Test-RepoUpToDate {
    param([string]$RepoRoot)

    # Native git writes to stderr, which throws under $ErrorActionPreference = 'Stop'.
    $ErrorActionPreference = 'Continue'
    $savedPrompt = $env:GIT_TERMINAL_PROMPT
    $env:GIT_TERMINAL_PROMPT = '0'
    try {
        git -C $RepoRoot rev-parse --is-inside-work-tree 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }

        git -C $RepoRoot remote get-url origin 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }

        $branch = git -C $RepoRoot symbolic-ref --short -q HEAD 2>$null
        if ($LASTEXITCODE -ne 0 -or $branch -ne 'master') { return $false }

        git -C $RepoRoot fetch -q origin master 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host '  NOTE: could not reach origin; skipping the up-to-date check.' -ForegroundColor DarkYellow
            return $false
        }

        $n = 0
        $count = git -C $RepoRoot rev-list --count HEAD..origin/master 2>$null
        if ($LASTEXITCODE -eq 0) { $n = [int]$count }
        if ($n -eq 0) { return $false }

        if (Test-Interactive) {
            $answer = Read-Host "  Repo is $n commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n]"
            if ($answer -eq '' -or $answer -match '^[Yy]') {
                git -C $RepoRoot pull --ff-only -q 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw 'pull failed; resolve it and rerun.'
                }
                Write-Host "  Pulled $n commit(s); run the command again." -ForegroundColor Green
                return $true
            }
        } else {
            Write-Host "  WARNING: repo is $n commit(s) behind origin/master; run git pull --ff-only." -ForegroundColor Yellow
        }
        return $false
    } finally {
        if ($null -eq $savedPrompt) {
            Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
        } else {
            $env:GIT_TERMINAL_PROMPT = $savedPrompt
        }
    }
}

# -- User values cache (.user-values.json) ------------------------------------

function Get-UserValues {
    param([string]$RepoRoot)
    $path = Join-Path $RepoRoot '.user-values.json'
    $ht = @{}
    if (Test-Path $path) {
        $raw = Get-Content $path -Raw | ConvertFrom-Json
        foreach ($prop in $raw.PSObject.Properties) {
            $ht[$prop.Name] = $prop.Value
        }
    }
    return $ht
}

function Save-UserValues {
    param([string]$RepoRoot, [hashtable]$Values)
    $path = Join-Path $RepoRoot '.user-values.json'
    $ordered = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($key in ($Values.Keys | Sort-Object)) {
        $ordered[$key] = $Values[$key]
    }
    $json = $ordered | ConvertTo-Json -Depth 10

    # Lock the file before writing, so new values never sit in a readable one.
    if (-not (Test-Path -LiteralPath $path)) {
        [IO.File]::WriteAllText($path, '')
    }
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    # Not Set-Acl: it asks the domain about the owner and fails with "trust relationship" when no domain
    # controller answers (a domain laptop off the network). This writes the same rules without that lookup.
    [IO.File]::SetAccessControl($path, $acl)

    [IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

# -- Sanitization (actual values -> placeholders) ------------------------------

function ConvertTo-Sanitized {
    param(
        [string]$Content,
        [array]$Rules,
        [hashtable]$UserValues
    )
    # Sort by value length descending to avoid partial replacements
    # e.g., "Jane Mary Doe" before "Jane" (if both existed)
    $sorted = $Rules | Sort-Object {
        $v = $UserValues[$_.placeholder]
        if ($v) { $v.Length } else { 0 }
    } -Descending

    foreach ($rule in $sorted) {
        $actual = $UserValues[$rule.placeholder]
        if ($actual -and $actual.Length -gt 0) {
            # Try escaped-backslash variant first (longer match = more specific).
            # Handles config files like .gitconfig that use \\ for literal backslashes.
            $escaped = $actual.Replace('\', '\\')
            if ($escaped -ne $actual) {
                $Content = $Content.Replace($escaped, $rule.placeholder)
            }
            # Then try the literal value
            $Content = $Content.Replace($actual, $rule.placeholder)
        }
    }
    return $Content
}

# -- Hydration (placeholders -> actual values) ---------------------------------

function ConvertFrom-Sanitized {
    param(
        [string]$Content,
        [array]$Rules,
        [hashtable]$UserValues
    )
    foreach ($rule in $Rules) {
        $actual = $UserValues[$rule.placeholder]
        if ($actual -and $actual.Length -gt 0 -and $Content.Contains($rule.placeholder)) {
            $replacement = $actual
            # If the rule has escapeBackslashes=true, always double backslashes.
            # This handles cases like .gitconfig where paths must use \\ escaping
            # but the surrounding context has no \\ left to detect after sanitization.
            $forceEscape = $rule.PSObject.Properties['escapeBackslashes'] -and $rule.escapeBackslashes -eq $true
            if ($forceEscape -and $actual.Contains('\')) {
                $replacement = $actual.Replace('\', '\\')
            }
            $Content = $Content.Replace($rule.placeholder, $replacement)
        }
    }
    return $Content
}

# -- Content comparison --------------------------------------------------------

function Compare-NormalizedContent {
    param([string]$A, [string]$B)
    # Normalize line endings and trailing whitespace
    $normA = ($A -replace "`r`n", "`n").TrimEnd()
    $normB = ($B -replace "`r`n", "`n").TrimEnd()
    return $normA -ceq $normB
}

function Compare-FilesByHash {
    param([string]$PathA, [string]$PathB)
    if (-not (Test-Path -LiteralPath $PathA) -or -not (Test-Path -LiteralPath $PathB)) { return $false }
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    $hashA = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($PathA)))
    $hashB = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($PathB)))
    $sha.Dispose()
    return $hashA -eq $hashB
}

# -- Safe file write (UTF-8 without BOM) --------------------------------------

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# -- Prompt for missing user values --------------------------------------------

function Request-MissingValues {
    <#
    .SYNOPSIS
        Prompts the user for any placeholder values not already in the cache.
    .PARAMETER Rules
        Array of sanitize rule objects from sync-config.json.
    .PARAMETER UserValues
        Hashtable of cached placeholder -> actual-value mappings (modified in-place).
    .PARAMETER ForceAll
        If true, re-prompt for every placeholder even if cached.
    .PARAMETER Direction
        'export' or 'import' -- adjusts prompt wording.
    #>
    param(
        [array]$Rules,
        [hashtable]$UserValues,
        [switch]$ForceAll,
        [string]$Direction = 'export'
    )

    $prompted = $false
    foreach ($rule in $Rules) {
        $cached = $UserValues[$rule.placeholder]
        $needsPrompt = $ForceAll -or (-not $cached) -or ($cached.Length -eq 0)

        if ($needsPrompt) {
            if (-not $prompted) {
                Write-Host
                if ($Direction -eq 'export') {
                    Write-Host '  Enter your actual values so we can sanitize them in the repo:' -ForegroundColor Cyan
                } else {
                    Write-Host '  Enter values to fill placeholders in the config files:' -ForegroundColor Cyan
                }
                Write-Host
                $prompted = $true
            }

            $promptText = "  $($rule.prompt)"

            # Show default: cached value, rule default, or the rule's defaultEnv variable
            $defaultVal = $null
            if ($cached -and $cached.Length -gt 0) {
                $defaultVal = $cached
            } elseif ($rule.PSObject.Properties['default'] -and $rule.default) {
                $defaultVal = $rule.default
            } elseif ($rule.PSObject.Properties['defaultEnv'] -and $rule.defaultEnv) {
                $envDefault = [Environment]::GetEnvironmentVariable($rule.defaultEnv)
                if ($envDefault) {
                    $defaultVal = $envDefault
                }
            }

            if ($defaultVal) {
                $promptText += " [$defaultVal]"
            }

            $value = $null
            if (Test-Interactive) {
                $value = Read-Host $promptText
                if (-not $value -and $defaultVal) {
                    $value = $defaultVal
                }
            } elseif ($defaultVal) {
                $value = $defaultVal
            }

            if (-not $value -or $value.Length -eq 0) {
                throw "missing value for $($rule.placeholder): add it to .user-values.json"
            }

            $UserValues[$rule.placeholder] = $value
        }
    }

    if ($prompted) { Write-Host }
}

# -- Linked path helpers -------------------------------------------------------

function Resolve-UnixPath {
    # Converts /c/MakuCustomAlias -> C:\MakuCustomAlias. Windows paths pass through.
    param([string]$Path)
    if ($Path -match '^[A-Za-z]:\\') { return $Path }
    if ($Path -match '^/([A-Za-z])/(.*)$') {
        $drive = $Matches[1].ToUpper()
        $rest  = $Matches[2] -replace '/', '\'
        return "${drive}:\$rest"
    }
    return $Path -replace '/', '\'
}

function Resolve-LinkedRepoPath {
    # Derives: "dotfiles/windows/shell/.bashrc" + "/c/MakuCustomAlias" -> "dotfiles/windows/shell/.bashrc.linked/MakuCustomAlias"
    param([string]$ParentRepoPath, [string]$LinkedLocalPath)
    $resolvedLocal = Resolve-UnixPath -Path $LinkedLocalPath
    $folderName    = Split-Path $resolvedLocal -Leaf
    return "$ParentRepoPath.linked/$folderName"
}

function Find-LinkedPaths {
    # Scans file content for directory paths.
    # Returns an array of unique Unix-style or Windows-style paths found.
    # Detects: /c/Folder, /d/Some/Path, C:\Folder, D:\Some\Path
    # Excludes system dirs, user profile, temp, Windows, Program Files, etc.
    # Use -SkipExistenceCheck during import (target dirs may not exist yet).
    param([string]$Content, [switch]$SkipExistenceCheck)

    $results = @{}

    # Pattern 1: Unix-style paths like /c/MakuCustomAlias or /d/Tools/Bin
    $unixMatches = [regex]::Matches($Content, '/([a-zA-Z])/([\w./-]+)')
    foreach ($m in $unixMatches) {
        $fullPath = $m.Value
        # Strip trailing filename patterns (e.g., /*.bat, /file.txt)
        $cleaned = $fullPath -replace '/\*\.[^/]*$', ''
        $cleaned = $cleaned.TrimEnd('/')
        $winPath = Resolve-UnixPath -Path $cleaned
        if (-not $results.ContainsKey($winPath)) { $results[$winPath] = $cleaned }
    }

    # Pattern 2: Windows-style paths like C:\MakuCustomAlias or D:\Tools
    $winMatches = [regex]::Matches($Content, '([A-Z]):\\([\w.\\-]+)')
    foreach ($m in $winMatches) {
        $winPath = $m.Value.TrimEnd('\')
        if (-not $results.ContainsKey($winPath)) { $results[$winPath] = $winPath }
    }

    # Filter: only keep paths that exist as directories on disk
    # and are not system/common directories we should never sync
    $skipPatterns = @(
        'C:\Windows', 'C:\Program Files', 'C:\Program Files (x86)',
        'C:\ProgramData', 'C:\Users', 'C:\Temp', 'C:\tmp'
    )

    $detected = @()
    foreach ($winPath in $results.Keys) {
        # Skip system directories
        $isSystem = $false
        foreach ($skip in $skipPatterns) {
            if ($winPath -like "$skip*") { $isSystem = $true; break }
        }
        if ($isSystem) { continue }

        # Skip user profile paths (those are handled by localPath with ~)
        if ($winPath -like "$env:USERPROFILE*") { continue }

        # Only keep if it actually exists as a directory (or skip check for import)
        if ($SkipExistenceCheck -or (Test-Path $winPath -PathType Container)) {
            $detected += $results[$winPath]
        }
    }

    return $detected
}

function Sync-LinkedDirectory {
    # Copies files from SourceDir to DestDir, comparing by hash. Direction-agnostic.
    # Returns hashtable: { added, modified, unchanged, skipped, removed }
    param(
        [string]$SourceDir,
        [string]$DestDir,
        [string]$Label,
        [string[]]$ExcludePatterns,
        [bool]$Recursive = $false,
        [string[]]$Only
    )

    $stats = @{ added = 0; modified = 0; unchanged = 0; skipped = 0; removed = 0 }
    $fileCount = 0

    if (-not (Test-Path -LiteralPath $SourceDir)) {
        Write-StatusLine 'SKIPPED' "$Label/" "WARNING: source directory not found: $SourceDir"
        return $stats
    }

    if (-not (Test-Path -LiteralPath $DestDir)) {
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    }

    $gciParams = @{ LiteralPath = $SourceDir; File = $true; Force = $true }
    if ($Recursive) { $gciParams['Recurse'] = $true }
    $sourceFiles = Get-ChildItem @gciParams

    foreach ($file in $sourceFiles) {
        $relPath  = $file.FullName.Substring($SourceDir.TrimEnd('\').Length + 1)
        $itemLabel = "$Label/" + ($relPath -replace '\\', '/')
        $destFile = Join-Path $DestDir $relPath

        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Write-StatusLine 'SKIPPED' $itemLabel 'symlink'
            $stats.skipped++
            continue
        }

        if (Test-Excluded -FilePath $file.FullName -Patterns $ExcludePatterns) {
            Write-StatusLine 'SKIPPED' $itemLabel 'matches exclude pattern'
            $stats.skipped++
            continue
        }

        # Count every non-symlink, non-excluded source file, so a --only pick
        # that selects nothing does not read as an empty folder (mirror bash).
        $fileCount++

        # A --only run copies only the picked files; everything else is left as-is.
        if (-not (Test-OnlySelected -RepoPath $itemLabel -Selected $Only)) { continue }

        $destDir2 = Split-Path $destFile -Parent
        if (-not (Test-Path -LiteralPath $destDir2)) {
            New-Item -ItemType Directory -Path $destDir2 -Force | Out-Null
        }

        if (-not (Test-Path -LiteralPath $destFile)) {
            Copy-Item -LiteralPath $file.FullName -Destination $destFile -Force
            Write-StatusLine 'ADDED' $itemLabel
            $stats.added++
        } elseif (Compare-FilesByHash -PathA $file.FullName -PathB $destFile) {
            Write-StatusLine 'UNCHANGED' $itemLabel
            $stats.unchanged++
        } else {
            Copy-Item -LiteralPath $file.FullName -Destination $destFile -Force
            Write-StatusLine 'MODIFIED' $itemLabel
            $stats.modified++
        }
    }

    # An empty source folder (or one holding only symlinks or excluded files)
    # must not empty the dest entry; keep the dest files and report it instead.
    if ($fileCount -eq 0) {
        $existingParams = @{ LiteralPath = $DestDir; File = $true; Force = $true }
        if ($Recursive) { $existingParams['Recurse'] = $true }
        if (@(Get-ChildItem @existingParams).Count -gt 0) {
            Write-StatusLine 'SKIPPED' "$Label/" 'local folder is empty; repo files kept'
            $stats.skipped++
            return $stats
        }
    }

    # Remove orphans: files in dest whose source is gone, a symlink, or now
    # excluded; then prune empty folders under the dest dir.
    if (Test-Path -LiteralPath $DestDir) {
        $destGciParams = @{ LiteralPath = $DestDir; File = $true; Force = $true }
        if ($Recursive) { $destGciParams['Recurse'] = $true }
        $destFiles = Get-ChildItem @destGciParams
        foreach ($df in $destFiles) {
            $relPath    = $df.FullName.Substring($DestDir.TrimEnd('\').Length + 1)
            $itemLabel  = "$Label/" + ($relPath -replace '\\', '/')

            # A --only run removes only files inside the selection.
            if (-not (Test-OnlySelected -RepoPath $itemLabel -Selected $Only)) { continue }

            $sourceFile = Join-Path $SourceDir $relPath

            $remove = -not (Test-Path -LiteralPath $sourceFile)
            if (-not $remove -and (Test-Excluded -FilePath $sourceFile -Patterns $ExcludePatterns)) {
                $remove = $true
            }
            if (-not $remove) {
                $sourceItem = Get-Item -LiteralPath $sourceFile -Force
                if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    $remove = $true
                }
            }

            if ($remove) {
                Remove-Item -LiteralPath $df.FullName -Force
                Write-StatusLine 'REMOVED' $itemLabel 'no longer in source'
                $stats.removed++
            }
        }

        if ($Recursive) {
            $emptyDirs = Get-ChildItem -LiteralPath $DestDir -Directory -Recurse -Force |
                Sort-Object { $_.FullName.Length } -Descending
            foreach ($dir in $emptyDirs) {
                if (@($dir.GetFileSystemInfos()).Count -eq 0) {
                    Remove-Item -LiteralPath $dir.FullName -Force
                }
            }
        }
    }

    return $stats
}

function Write-OrphanReport {
    <#
    .SYNOPSIS
        Lists files under dotfiles/ that no sync-config.json entry owns.
    .DESCRIPTION
        Uses every entry, not just this platform's, so both engines print the
        same list. A file is owned when it is an entry's repoPath, lies under a
        dir entry's repoPath/, or lies under <repoPath>.linked/ of an entry with
        detectLinkedPaths. Reports only: never deletes, and never changes the
        change count or the exit code.
    #>
    param(
        [string]$RepoRoot,
        $Entries
    )

    $base         = $RepoRoot.TrimEnd('\', '/')
    $dotfilesRoot = Join-Path $base 'dotfiles'
    if (-not (Test-Path $dotfilesRoot -PathType Container)) { return }

    $exactPaths  = @()
    $prefixPaths = @()
    foreach ($entry in @($Entries)) {
        $repoPath = ([string]$entry.repoPath) -replace '\\', '/'
        $exactPaths += $repoPath
        if ($entry.PSObject.Properties['type'] -and $entry.type -eq 'dir') {
            $prefixPaths += "$repoPath/"
        }
        if ($entry.PSObject.Properties['detectLinkedPaths'] -and $entry.detectLinkedPaths -eq $true) {
            $prefixPaths += "$repoPath.linked/"
        }
    }

    $files = Get-ChildItem -Path $dotfilesRoot -File -Recurse -Force
    foreach ($file in $files) {
        $rel = ($file.FullName.Substring($base.Length).TrimStart('\', '/')) -replace '\\', '/'

        $owned = $false
        foreach ($exact in $exactPaths) {
            if ($rel -ieq $exact) { $owned = $true; break }
        }
        if (-not $owned) {
            foreach ($prefix in $prefixPaths) {
                if ($rel.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $owned = $true; break }
            }
        }

        if (-not $owned) {
            Write-StatusLine 'ORPHAN' $rel 'no entry in sync-config.json; git rm it or add an entry'
        }
    }
}

# -- Leak scan -----------------------------------------------------------------

function Find-GitBash {
    # Returns the full path to Git's bash.exe, or $null when git is not on PATH
    # or bash.exe is not where Git for Windows keeps it. git.exe is in <root>\cmd,
    # or in <root>\mingw64\bin when PATH comes from a Git Bash shell.
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { return $null }
    $parent = Split-Path (Split-Path $git.Source -Parent) -Parent
    foreach ($root in @($parent, (Split-Path $parent -Parent))) {
        if (-not $root) { continue }
        $candidate = Join-Path $root 'bin\bash.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Invoke-LeakScan {
    <#
    .SYNOPSIS
        Runs scripts/ci/leak-scan.sh over the given paths.
    .DESCRIPTION
        Returns 0 when clean, 1 when it found a hit, 2 when it could not run
        (script missing, no bash, or any exit code other than 0 and 1). The
        scanner's output reaches the console so the hit lines show.
    #>
    param([string]$RepoRoot, [string[]]$Paths)

    $scan = Join-Path $RepoRoot 'scripts\ci\leak-scan.sh'
    if (-not (Test-Path $scan)) { return 2 }

    $bash = Find-GitBash
    if (-not $bash) { return 2 }

    # Native bash may write to stderr; keep it from throwing under Stop, and
    # pipe stdout to the console so the hit lines show without leaking into
    # this function's return value.
    $ErrorActionPreference = 'Continue'
    & $bash $scan @Paths | Out-Host
    $leakExit = $LASTEXITCODE

    if ($leakExit -eq 0) { return 0 }
    if ($leakExit -eq 1) { return 1 }
    return 2
}

# -- Export preview ------------------------------------------------------------

function Invoke-ExportPreview {
    <#
    .SYNOPSIS
        Shows what a real export would write to the repo, without touching the repo.
    .DESCRIPTION
        Copies dotfiles/, sync-config.json, scripts/ and .user-values.json into a
        throwaway folder, runs Export-Settings.ps1 there, and diffs the result
        against HEAD. The leak scan runs before any diff so a hit never prints the
        leaked text. Returns the process exit code.
    #>
    param([string]$RepoRoot, [string]$User)

    # Native git/tar/bash write to stderr, which must not throw.
    $ErrorActionPreference = 'Continue'

    git -C $RepoRoot rev-parse --verify -q HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: --preview needs a git repo with a commit.' -ForegroundColor Red
        return 1
    }

    $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    $null = New-Item -ItemType Directory -Path $tmpDir -Force
    $beforeDir = Join-Path $tmpDir 'before'
    $afterDir  = Join-Path $tmpDir 'after'
    $null = New-Item -ItemType Directory -Path $beforeDir -Force
    $null = New-Item -ItemType Directory -Path $afterDir -Force

    $savedSyncPreview = $env:SYNC_PREVIEW
    try {
        # HEAD's copy of the tracked files, as the diff baseline.
        $beforeTar = Join-Path $tmpDir 'before.tar'
        git -C $RepoRoot archive -o $beforeTar HEAD -- dotfiles sync-config.json
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ERROR: git archive failed.' -ForegroundColor Red
            return 1
        }
        # The Windows tar by full path: Git's GNU tar reads C: as a remote host.
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $beforeTar -C $beforeDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ERROR: tar failed.' -ForegroundColor Red
            return 1
        }

        # The working tree plus the engine itself, for a real export in after/.
        Copy-Item -Path (Join-Path $RepoRoot 'dotfiles') -Destination $afterDir -Recurse -Force
        Copy-Item -Path (Join-Path $RepoRoot 'sync-config.json') -Destination $afterDir -Force
        Copy-Item -Path (Join-Path $RepoRoot 'scripts') -Destination $afterDir -Recurse -Force
        $valuesFile = Join-Path $RepoRoot '.user-values.json'
        if (Test-Path $valuesFile) {
            Copy-Item -Path $valuesFile -Destination $afterDir -Force
        }

        $env:SYNC_PREVIEW = '1'
        $afterScript = Join-Path $afterDir 'scripts\windows\Export-Settings.ps1'
        # Start-Process, not &: its output stays out of this function's return value,
        # and a piped child would hide the value prompts, which end without a newline.
        $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$afterScript`"", '-User', "`"$User`"")
        $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArgs -NoNewWindow -Wait -PassThru
        if ($child.ExitCode -ne 0) {
            return $child.ExitCode
        }

        Push-Location $tmpDir
        try {
            # Scan first: a hit must suppress the diff, which would print the leaked text.
            $leakFound = 0
            $leakCode = Invoke-LeakScan -RepoRoot $RepoRoot -Paths @('after/dotfiles', 'after/sync-config.json')
            if ($leakCode -eq 1) {
                Write-Host '  WARNING: the leak scan found the lines above. Fix them before committing.'
                $leakFound = 1
            } elseif ($leakCode -ne 0) {
                Write-Host 'ERROR: leak scan could not run; nothing was committed.' -ForegroundColor Red
                return 1
            } else {
                Write-Host '  Leak scan: clean.'
            }

            if ($leakFound -eq 0) {
                $differed = 0
                foreach ($path in @('dotfiles', 'sync-config.json')) {
                    git -c core.safecrlf=false --no-pager diff --no-index --stat "before/$path" "after/$path" | Out-Host
                    $code = $LASTEXITCODE
                    if ($code -eq 1) {
                        $differed = 1
                    } elseif ($code -gt 1) {
                        Write-Host 'ERROR: git diff failed.' -ForegroundColor Red
                        return 1
                    }
                }

                if ($differed) {
                    foreach ($path in @('dotfiles', 'sync-config.json')) {
                        git -c core.safecrlf=false --no-pager diff --no-index "before/$path" "after/$path" | Out-Host
                        $code = $LASTEXITCODE
                        if ($code -gt 1) {
                            Write-Host 'ERROR: git diff failed.' -ForegroundColor Red
                            return 1
                        }
                    }
                } else {
                    Write-Host '  Nothing would be sent: the repo matches HEAD.'
                }
            }

            Write-Host '  Nothing was written. Run mksync push to send it.'
            return $leakFound
        } finally {
            Pop-Location
        }
    } finally {
        if ($null -eq $savedSyncPreview) {
            Remove-Item Env:\SYNC_PREVIEW -ErrorAction SilentlyContinue
        } else {
            $env:SYNC_PREVIEW = $savedSyncPreview
        }
        if (Test-Path $tmpDir) {
            Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# -- Export diff ---------------------------------------------------------------

function Invoke-ExportDiff {
    <#
    .SYNOPSIS
        Says which side changed each file this machine owns, without writing anything.
    .DESCRIPTION
        Builds three trees of dotfiles/ in a throwaway folder: base (the sync
        point), theirs (origin/master when it exists, else HEAD) and mine (base
        plus the current engine and config, with a preview export run inside
        it). Every owned path gets at most one label: IN, OUT, BOTH or ?.
        Returns 0 when nothing differs, 3 when something does and 1 on an error.
    #>
    param([string]$RepoRoot, [string]$User, [string[]]$Only)

    # Native git/tar write to stderr, which must not throw.
    $ErrorActionPreference = 'Continue'

    git -C $RepoRoot rev-parse --verify -q HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: --diff needs a git repo with a commit.' -ForegroundColor Red
        return 1
    }

    $tmpDir    = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    $baseDir   = Join-Path $tmpDir 'base'
    $theirsDir = Join-Path $tmpDir 'theirs'
    $mineDir   = Join-Path $tmpDir 'mine'
    $null = New-Item -ItemType Directory -Path $tmpDir -Force
    $null = New-Item -ItemType Directory -Path $baseDir, $theirsDir, $mineDir -Force

    # The Windows tar by full path: Git's GNU tar reads C: as a remote host.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'

    $savedSyncPreview = $env:SYNC_PREVIEW
    try {
        # base: the tree this machine last agreed with (the sync point).
        $haveBase = $false
        $syncSha  = Read-LastSync -RepoRoot $RepoRoot
        if ($syncSha) {
            $haveBase = $true
            $baseTar = Join-Path $tmpDir 'base.tar'
            git -C $RepoRoot archive -o $baseTar $syncSha -- dotfiles
            if ($LASTEXITCODE -ne 0) {
                Write-Host "ERROR: git archive failed for $syncSha." -ForegroundColor Red
                return 1
            }
            & $tar -xf $baseTar -C $baseDir
            if ($LASTEXITCODE -ne 0) {
                Write-Host 'ERROR: tar failed.' -ForegroundColor Red
                return 1
            }
        }

        # theirs: the repo's side. The engine never fetches.
        git -C $RepoRoot rev-parse --verify -q origin/master 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $repoRef = 'origin/master'
        } else {
            $repoRef = 'HEAD'
        }
        $repoSha = (git -C $RepoRoot log -1 --format=%h $repoRef 2>$null | Out-String).Trim()
        $theirsTar = Join-Path $tmpDir 'theirs.tar'
        git -C $RepoRoot archive -o $theirsTar $repoRef -- dotfiles
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: git archive failed for $repoRef." -ForegroundColor Red
            return 1
        }
        & $tar -xf $theirsTar -C $theirsDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'ERROR: tar failed.' -ForegroundColor Red
            return 1
        }

        # With no sync point the repo's tree stands in for the base, so every
        # difference is machine against repo and no side can be called newer.
        $theirsDotfiles = Join-Path $theirsDir 'dotfiles'
        if (-not $haveBase -and (Test-Path -LiteralPath $theirsDotfiles -PathType Container)) {
            Copy-Item -Path $theirsDotfiles -Destination $baseDir -Recurse -Force
        }

        # mine: the base plus the current engine and config, then a preview
        # export inside it. A file export doesn't touch therefore still equals base.
        $baseDotfiles = Join-Path $baseDir 'dotfiles'
        if (Test-Path -LiteralPath $baseDotfiles -PathType Container) {
            Copy-Item -Path $baseDotfiles -Destination $mineDir -Recurse -Force
        }
        Copy-Item -Path (Join-Path $RepoRoot 'sync-config.json') -Destination $mineDir -Force
        Copy-Item -Path (Join-Path $RepoRoot 'scripts') -Destination $mineDir -Recurse -Force
        $packagesDir = Join-Path $RepoRoot 'packages'
        if (Test-Path -LiteralPath $packagesDir -PathType Container) {
            Copy-Item -Path $packagesDir -Destination $mineDir -Recurse -Force
        }
        $valuesFile = Join-Path $RepoRoot '.user-values.json'
        if (Test-Path -LiteralPath $valuesFile) {
            Copy-Item -Path $valuesFile -Destination $mineDir -Force
        }

        # The export runs in a child process, stdin from an empty file and
        # output to a log, so a prompt can never reach this terminal.
        $env:SYNC_PREVIEW = '1'
        $mineScript = Join-Path $mineDir 'scripts\windows\Export-Settings.ps1'
        $exportLog  = Join-Path $tmpDir 'export.log'
        $exportErr  = Join-Path $tmpDir 'export.err.log'
        $emptyIn    = Join-Path $tmpDir 'stdin.txt'
        [IO.File]::WriteAllText($emptyIn, '')
        $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$mineScript`"", '-User', "`"$User`"")
        $childParams = @{
            FilePath               = 'powershell.exe'
            ArgumentList           = $childArgs
            NoNewWindow            = $true
            Wait                   = $true
            PassThru               = $true
            RedirectStandardInput  = $emptyIn
            RedirectStandardOutput = $exportLog
            RedirectStandardError  = $exportErr
        }
        $child = Start-Process @childParams
        if ($child.ExitCode -ne 0) {
            if (Test-Path -LiteralPath $exportLog) { Get-Content -LiteralPath $exportLog | Out-Host }
            if (Test-Path -LiteralPath $exportErr) { Get-Content -LiteralPath $exportErr | Out-Host }
            Write-Host '  ERROR: the export for the diff failed; see above.' -ForegroundColor Red
            return 1
        }

        # The paths this OS's entries own: a file or dconf entry its repoPath, a
        # file entry also its .linked/ prefix, a dir entry its folder prefix.
        $config  = Get-Content -LiteralPath (Join-Path $RepoRoot 'sync-config.json') -Raw | ConvertFrom-Json
        $entries = @(Select-WindowsEntries -Files @($config.files))
        $ownedExact  = @()
        $ownedLinked = @()
        $ownedDirs   = @()
        foreach ($entry in $entries) {
            $repoPath  = [string]$entry.repoPath
            $entryType = 'file'
            if ($entry.PSObject.Properties['type'] -and $entry.type) { $entryType = [string]$entry.type }
            if ($entryType -eq 'dir') {
                $ownedDirs += "$repoPath/"
            } else {
                $ownedExact += $repoPath
                if ($entryType -eq 'file') {
                    $ownedLinked += "$repoPath.linked/"
                }
            }
        }

        Write-Host
        Write-Host '  SyncSettings -- DIFF (windows)'
        Write-Host
        if ($haveBase) {
            $lastLine = (git -C $RepoRoot log -1 "--format=%h (%cs)" $syncSha 2>$null | Out-String).Trim()
        } else {
            $lastLine = 'none recorded on this machine'
        }
        Write-Host "  Last sync  : $lastLine"
        Write-Host "  Repo       : $repoRef $repoSha"
        Write-Host

        # Every file in the union of the three trees, as dotfiles/ relative
        # paths with / separators, sorted ordinally like LC_ALL=C sort.
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($tree in @($baseDir, $theirsDir, $mineDir)) {
            $root = Get-Item -LiteralPath (Join-Path $tree 'dotfiles') -Force -ErrorAction SilentlyContinue
            if (-not $root) { continue }
            $prefix = $root.FullName.TrimEnd('\') + '\'
            foreach ($file in Get-ChildItem -LiteralPath $root.FullName -Recurse -File -Force -ErrorAction SilentlyContinue) {
                $rel = $file.FullName.Substring($prefix.Length) -replace '\\', '/'
                $null = $seen.Add("dotfiles/$rel")
            }
        }
        $paths = [System.Collections.Generic.List[string]]::new()
        foreach ($item in $seen) { $paths.Add($item) }
        $paths.Sort([System.StringComparer]::Ordinal)

        # True when two paths under the diff's trees hold the same version. A
        # path absent on both sides counts as the same version.
        function Test-DiffPathSame {
            param([string]$PathA, [string]$PathB)
            $a = Test-Path -LiteralPath $PathA -PathType Leaf
            $b = Test-Path -LiteralPath $PathB -PathType Leaf
            if ($a -and $b) { return (Compare-FilesByHash -PathA $PathA -PathB $PathB) }
            return (-not $a -and -not $b)
        }

        $inCount = 0
        $outCount = 0
        $bothCount = 0
        $unknownCount = 0
        $diffLines = [System.Collections.Generic.List[string]]::new()

        foreach ($path in $paths) {
            $ownedHere = $false
            foreach ($prefix in $ownedExact) {
                if ($path -ceq $prefix) { $ownedHere = $true; break }
            }
            if (-not $ownedHere) {
                foreach ($prefix in $ownedLinked) {
                    if ($path.StartsWith($prefix, [System.StringComparison]::Ordinal)) { $ownedHere = $true; break }
                }
            }
            if (-not $ownedHere) {
                foreach ($prefix in $ownedDirs) {
                    if ($path.StartsWith($prefix, [System.StringComparison]::Ordinal)) { $ownedHere = $true; break }
                }
            }
            if (-not $ownedHere) { continue }

            # A --only diff labels only the picked paths, so the exit code
            # (0/3) reflects the selection, not the whole machine.
            if (-not (Test-OnlySelected -RepoPath $path -Selected $Only)) { continue }

            $minePath   = Join-Path $mineDir $path
            $basePath   = Join-Path $baseDir $path
            $theirsPath = Join-Path $theirsDir $path

            $mineBase   = Test-DiffPathSame $minePath $basePath
            $theirsBase = Test-DiffPathSame $theirsPath $basePath

            $label = ''
            if ($haveBase) {
                if ($mineBase -and $theirsBase) {
                    $label = ''
                } elseif ($mineBase) {
                    $label = 'IN'
                } elseif ($theirsBase) {
                    $label = 'OUT'
                } elseif (Test-DiffPathSame $minePath $theirsPath) {
                    # Both sides made the same change.
                    $label = ''
                } else {
                    $label = 'BOTH'
                }
            } elseif (-not (Test-DiffPathSame $minePath $theirsPath)) {
                $label = '?'
            }

            switch ($label) {
                'IN'   { $inCount++;      $diffLines.Add("IN $path") }
                'OUT'  { $outCount++;     $diffLines.Add("OUT $path") }
                'BOTH' { $bothCount++;    $diffLines.Add("BOTH $path") }
                '?'    { $unknownCount++; $diffLines.Add("? $path") }
            }
        }

        foreach ($line in $diffLines) {
            $space = $line.IndexOf(' ')
            Write-StatusLine $line.Substring(0, $space) $line.Substring($space + 1)
        }
        if (($unknownCount + $inCount + $outCount + $bothCount) -gt 0) {
            Write-Host
        }

        Write-OnlyNoHitsWarning -Selected $Only

        Write-Host ('  ' + ('-' * 50))
        Write-Host

        if (($inCount + $outCount + $bothCount + $unknownCount) -eq 0) {
            Write-Host '  This machine and the repo agree.'
            Write-Host
            return 0
        }

        if (-not $haveBase) {
            Write-Host ("  {0} file(s) differ. No sync is recorded on this machine, so the newer side is unknown." -f $unknownCount)
            Write-Host '  Run mksync pull or mksync push once to record one.'
            Write-Host
            return 3
        }

        $differCount = $inCount + $outCount + $bothCount
        Write-Host ("  {0} file(s) differ: {1} in, {2} out, {3} both." -f $differCount, $inCount, $outCount, $bothCount)
        $hints = ''
        if ($inCount -gt 0) {
            $hints = 'IN: mksync pull takes them.'
        }
        if ($outCount -gt 0) {
            if ($hints) { $hints = "$hints OUT: mksync push sends them." } else { $hints = 'OUT: mksync push sends them.' }
        }
        if ($bothCount -gt 0) {
            if ($hints) { $hints = "$hints BOTH: changed on both sides; merge by hand." } else { $hints = 'BOTH: changed on both sides; merge by hand.' }
        }
        Write-Host "  $hints"
        Write-Host

        return 3
    } finally {
        if ($null -eq $savedSyncPreview) {
            Remove-Item Env:\SYNC_PREVIEW -ErrorAction SilentlyContinue
        } else {
            $env:SYNC_PREVIEW = $savedSyncPreview
        }
        if (Test-Path $tmpDir) {
            Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# -- Import helpers ------------------------------------------------------------

function Copy-RepoFileToLocal {
    <#
    .SYNOPSIS
        Copies one repo file onto its local path (the plain, non-sanitized flow).
    .DESCRIPTION
        Creates the file when it is missing, compares by hash when it exists,
        and otherwise prompts before overwriting (unless -Force), keeping a .bak
        of the old file. Returns the status word: CREATED, UPDATED, UNCHANGED or SKIPPED.
        With -Check it writes nothing and returns CREATE or UPDATE instead.
    #>
    param(
        [string]$RepoFile,
        [string]$LocalFile,
        [string]$Label,
        [bool]$Force = $false,
        [bool]$Check = $false
    )

    if (-not (Test-Path -LiteralPath $LocalFile)) {
        if ($Check) {
            Write-StatusLine 'CREATE' $Label
            return 'CREATE'
        }
        Copy-Item -LiteralPath $RepoFile -Destination $LocalFile -Force
        Write-StatusLine 'CREATED' $Label
        return 'CREATED'
    } elseif (Compare-FilesByHash -PathA $RepoFile -PathB $LocalFile) {
        Write-StatusLine 'UNCHANGED' $Label
        return 'UNCHANGED'
    } else {
        if ($Check) {
            Write-StatusLine 'UPDATE' $Label
            return 'UPDATE'
        }
        if (-not $Force) {
            Write-Host
            Write-Host "  File differs: $LocalFile" -ForegroundColor Yellow
            $answer = Read-Host '  Overwrite? [Y/n]'
            if ($answer -ne '' -and $answer -notmatch '^[Yy]') {
                Write-StatusLine 'SKIPPED' $Label 'user skipped'
                Write-Host
                return 'SKIPPED'
            }
            Write-Host
        }
        Copy-Item -LiteralPath $LocalFile -Destination "$LocalFile.bak" -Force
        Save-DatedBackup -Source $LocalFile -RepoPath $Label
        Copy-Item -LiteralPath $RepoFile  -Destination $LocalFile      -Force
        Write-StatusLine 'UPDATED' $Label "backup saved as $(Split-Path "$LocalFile.bak" -Leaf)"
        return 'UPDATED'
    }
}

function Import-DirEntry {
    <#
    .SYNOPSIS
        Imports every file under a type:dir entry from the repo onto the machine.
    .DESCRIPTION
        Import never deletes: a local file the repo does not have is reported as
        EXTRA and kept. Each repo file follows the same compare / prompt / .bak /
        copy flow as a plain file entry. Returns the number of files applied.
        With -Check it writes nothing and returns the number of files that would change.
    #>
    param(
        [string]$RepoDir,
        [string]$LocalDir,
        [string]$Label,
        [string[]]$ExcludePatterns,
        [bool]$Force = $false,
        [bool]$Check = $false,
        [string[]]$Only,
        $ErrorCount = $null
    )

    if (-not (Test-Path -LiteralPath $RepoDir -PathType Container)) {
        Write-StatusLine 'SKIPPED' "$Label/" 'not found in repo'
        return 0
    }

    $localParent = Split-Path $LocalDir -Parent
    if (-not (Test-Path -LiteralPath $localParent)) {
        Write-StatusLine 'SKIPPED' "$Label/" "WARNING: target folder not found: $localParent"
        return 0
    }

    if (-not $Check -and -not (Test-Path -LiteralPath $LocalDir)) {
        New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null
    }

    $applied = 0
    foreach ($file in (Get-ChildItem -LiteralPath $RepoDir -File -Recurse -Force)) {
        $rel = $file.FullName.Substring($RepoDir.TrimEnd('\').Length + 1)
        $itemLabel = "$Label/" + ($rel -replace '\\', '/')
        if (-not (Test-OnlySelected -RepoPath $itemLabel -Selected $Only)) { continue }
        $localFile = Join-Path $LocalDir $rel

        if (Test-Excluded -FilePath $localFile -Patterns $ExcludePatterns) {
            Write-StatusLine 'SKIPPED' $itemLabel 'matches exclude pattern'
            continue
        }

        try {
            $localFileParent = Split-Path $localFile -Parent
            if (-not $Check -and -not (Test-Path -LiteralPath $localFileParent)) {
                New-Item -ItemType Directory -Path $localFileParent -Force | Out-Null
            }

            $result = Copy-RepoFileToLocal -RepoFile $file.FullName -LocalFile $localFile -Label $itemLabel -Force $Force -Check $Check
            if ($result -eq 'CREATED' -or $result -eq 'UPDATED' -or $result -eq 'CREATE' -or $result -eq 'UPDATE') { $applied++ }
        } catch {
            Write-StatusLine 'ERROR' $itemLabel $_.Exception.Message
            if ($null -ne $ErrorCount) { $ErrorCount.Value++ }
        }
    }

    if (Test-Path -LiteralPath $LocalDir) {
        foreach ($file in (Get-ChildItem -LiteralPath $LocalDir -File -Recurse -Force)) {
            $rel = $file.FullName.Substring($LocalDir.TrimEnd('\').Length + 1)
            $itemLabel = "$Label/" + ($rel -replace '\\', '/')
            if (-not (Test-OnlySelected -RepoPath $itemLabel -Selected $Only)) { continue }
            if (Test-Path -LiteralPath (Join-Path $RepoDir $rel)) {
                continue
            }
            if (Test-Excluded -FilePath $file.FullName -Patterns $ExcludePatterns) {
                continue
            }
            Write-StatusLine 'EXTRA' $itemLabel 'not in repo; kept'
        }
    }

    return $applied
}

function Import-LinkedDirectory {
    <#
    .SYNOPSIS
        Imports the files of one linked folder from the repo onto the machine.
    .DESCRIPTION
        Import never deletes: a local file the repo does not have is reported as
        EXTRA and kept. Each repo file follows the same compare / prompt / .bak /
        copy flow as a plain file entry, so -Force skips only the prompt. Linked
        folders are non-recursive, matching the current import call. Returns the
        number of files applied.
        With -Check it writes nothing and returns the number of files that would change.
    #>
    param(
        [string]$SourceDir,
        [string]$DestDir,
        [string]$Label,
        [string[]]$ExcludePatterns,
        [bool]$Force = $false,
        [bool]$Check = $false,
        [string[]]$Only,
        $ErrorCount = $null
    )

    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        Write-StatusLine 'SKIPPED' "$Label/" 'not found in repo'
        return 0
    }

    if (-not $Check -and -not (Test-Path -LiteralPath $DestDir)) {
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    }

    $applied = 0
    foreach ($file in (Get-ChildItem -LiteralPath $SourceDir -File -Force)) {
        $itemLabel = "$Label/" + $file.Name
        if (-not (Test-OnlySelected -RepoPath $itemLabel -Selected $Only)) { continue }
        $localFile = Join-Path $DestDir $file.Name

        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Write-StatusLine 'SKIPPED' $itemLabel 'symlink'
            continue
        }

        if (Test-Excluded -FilePath $file.FullName -Patterns $ExcludePatterns) {
            Write-StatusLine 'SKIPPED' $itemLabel 'matches exclude pattern'
            continue
        }

        try {
            $result = Copy-RepoFileToLocal -RepoFile $file.FullName -LocalFile $localFile -Label $itemLabel -Force $Force -Check $Check
            if ($result -eq 'CREATED' -or $result -eq 'UPDATED' -or $result -eq 'CREATE' -or $result -eq 'UPDATE') { $applied++ }
        } catch {
            Write-StatusLine 'ERROR' $itemLabel $_.Exception.Message
            if ($null -ne $ErrorCount) { $ErrorCount.Value++ }
        }
    }

    if (Test-Path -LiteralPath $DestDir) {
        foreach ($file in (Get-ChildItem -LiteralPath $DestDir -File -Force)) {
            $itemLabel = "$Label/" + $file.Name
            if (-not (Test-OnlySelected -RepoPath $itemLabel -Selected $Only)) { continue }
            if (Test-Path -LiteralPath (Join-Path $SourceDir $file.Name)) {
                continue
            }
            if (Test-Excluded -FilePath $file.FullName -Patterns $ExcludePatterns) {
                continue
            }
            Write-StatusLine 'EXTRA' $itemLabel 'not in repo; kept'
        }
    }

    return $applied
}

# -- Sync point ----------------------------------------------------------------

# Where this machine records the repo commit it last agreed with.
function Get-LastSyncFile {
    return (Join-Path $env:LOCALAPPDATA 'SyncSettings\last-sync')
}

# The recorded SHA when the file's first line is 40 hex characters and names a
# commit in this clone; anything else is "no sync point" and returns $null.
function Read-LastSync {
    param([string]$RepoRoot)
    # git cat-file writes to stderr for a missing commit, which must not throw.
    $ErrorActionPreference = 'Continue'
    $file = Get-LastSyncFile
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try {
        $sha = [string](Get-Content -LiteralPath $file -TotalCount 1 -ErrorAction Stop)
    } catch {
        return $null
    }
    if ($sha -cnotmatch '^[0-9a-f]{40}$') { return $null }
    git -C $RepoRoot cat-file -e "${sha}^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $sha
}

# Record a SHA as this machine's sync point. A failure prints a WARNING and
# never throws: the sync point is a convenience, never a reason to fail a run.
function Write-LastSync {
    param([string]$Sha)
    $file = Get-LastSyncFile
    $dir  = Split-Path $file -Parent
    $tmp  = Join-Path $dir ('.last-sync.' + $PID)
    try {
        $null = New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop
        [IO.File]::WriteAllText($tmp, "$Sha`n")
        Move-Item -LiteralPath $tmp -Destination $file -Force -ErrorAction Stop
        return
    } catch {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Write-Host "  WARNING: could not record the sync point in $file." -ForegroundColor Yellow
    }
}

# -- Dated backups -------------------------------------------------------------

# The folder this run keeps its dated backups in, made once per process. It is
# printed, and cached in $script:BackupRunDir so every backup of one run lands
# together even when the run crosses a second.
$script:BackupRunDir = $null
# Set to $true when this run kept a dated copy, so the caller prunes old runs
# and names the folder in the summary.
$script:BackupMade = $false

function Get-BackupRunDir {
    if (-not $script:BackupRunDir) {
        $run = Get-Date -Format 'yyyyMMdd-HHmmss'
        $script:BackupRunDir = Join-Path $env:LOCALAPPDATA ("SyncSettings\backups\$run-$PID")
    }
    return $script:BackupRunDir
}

# Copy an old local version into this run's folder. A failure prints a WARNING
# and never throws: the .bak is the backup that must succeed.
function Save-DatedBackup {
    param(
        [string]$Source,
        [string]$RepoPath
    )
    try {
        $dest = Join-Path (Get-BackupRunDir) ($RepoPath -replace '/', '\')
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force -ErrorAction Stop
        Copy-Item -LiteralPath $Source -Destination $dest -Force -ErrorAction Stop
        $script:BackupMade = $true
    } catch {
        Write-Host "  WARNING: could not keep a dated backup of $RepoPath." -ForegroundColor Yellow
    }
}

# Keep only the newest 20 run folders under the backups folder, sorted by name
# (the run name is a local-time timestamp, so name order is age order).
function Remove-OldBackupRuns {
    $backupRoot = Split-Path (Get-BackupRunDir) -Parent
    if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) { return }
    $runs = @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object -Property Name)
    for ($i = 0; $i -lt ($runs.Count - 20); $i++) {
        Remove-Item -LiteralPath $runs[$i].FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# -- Status output -------------------------------------------------------------

# SKIPPED lines noted "user skipped" in the current run, so a caller can tell a
# clean, unattended run apart.
$script:UserSkips = 0

# File lines printed in this run, so a -Only pick that reached nothing can warn.
$script:OnlyHits = 0

function Write-StatusLine {
    param([string]$Status, [string]$File, [string]$Note = '')
    $script:OnlyHits++
    if ($Status -eq 'SKIPPED' -and $Note -eq 'user skipped') {
        $script:UserSkips++
    }
    $color = switch ($Status) {
        'ADDED'     { 'Green' }
        'MODIFIED'  { 'Yellow' }
        'CREATED'   { 'Green' }
        'UPDATED'   { 'Yellow' }
        'CREATE'    { 'Cyan' }
        'UPDATE'    { 'Yellow' }
        'UNCHANGED' { 'DarkGray' }
        'SKIPPED'   { 'DarkYellow' }
        'EXTRA'     { 'DarkYellow' }
        'REMOVED'   { 'Red' }
        'ORPHAN'    { 'Magenta' }
        'ERROR'     { 'Red' }
        default     { 'White' }
    }
    $label = $Status.PadRight(10)
    Write-Host "  [$label] " -ForegroundColor $color -NoNewline
    Write-Host $File -NoNewline
    if ($Note) { Write-Host "  ($Note)" -ForegroundColor DarkGray } else { Write-Host }
}

function Write-OnlyNoHitsWarning {
    param([string[]]$Selected)
    if ($null -ne $Selected -and $Selected.Count -gt 0 -and $script:OnlyHits -eq 0) {
        Write-Host '  WARNING: --only matched no file.'
    }
}
