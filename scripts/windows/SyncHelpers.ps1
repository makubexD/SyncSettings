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
    # Only entries with platform "windows" or "common" belong to the PowerShell scripts.
    # "linux" entries belong to the bash scripts; anything else is caught by Assert-ValidPlatform.
    param($Entry)
    return ($Entry.platform -eq 'windows') -or ($Entry.platform -eq 'common')
}

function Assert-ValidPlatform {
    <#
    .SYNOPSIS
        Stops the run if any entry has a missing or invalid platform.
    .DESCRIPTION
        Every entry must name one of "common", "windows" or "linux". The check
        covers all entries, not only the ones this engine selects, so a bad
        Linux entry also stops the Windows engine.
    #>
    param([array]$Files)
    foreach ($entry in $Files) {
        $prop  = $entry.PSObject.Properties['platform']
        $valid = $prop -and ($prop.Value -eq 'common' -or $prop.Value -eq 'windows' -or $prop.Value -eq 'linux')
        if (-not $valid) {
            throw ('sync-config.json: entry {0} needs "platform": "common", "windows" or "linux".' -f $entry.repoPath)
        }
    }
}

function Resolve-LocalPath {
    param([string]$Template, [string]$ProfileRoot)
    # "~/..." works on both engines: expand ~ first, then use backslashes on Windows.
    $path = $Template -replace '^~', $ProfileRoot
    return $path -replace '/', '\'
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
    return $normA -eq $normB
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

            if (Test-Interactive) {
                $value = Read-Host $promptText
                if (-not $value -and $defaultVal) {
                    $value = $defaultVal
                }
            } elseif ($defaultVal) {
                $value = $defaultVal
            } else {
                throw "missing value for $($rule.placeholder): add it to .user-values.json"
            }

            if ($value -and $value.Length -gt 0) {
                $UserValues[$rule.placeholder] = $value
            }
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
    # Derives: "dotfiles/.bashrc" + "/c/MakuCustomAlias" -> "dotfiles/.bashrc.linked/MakuCustomAlias"
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
        [bool]$Recursive = $false
    )

    $stats = @{ added = 0; modified = 0; unchanged = 0; skipped = 0; removed = 0 }

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

    # Remove orphans: files in dest whose source is gone, a symlink, or now
    # excluded; then prune empty folders under the dest dir.
    if (Test-Path -LiteralPath $DestDir) {
        $destGciParams = @{ LiteralPath = $DestDir; File = $true; Force = $true }
        if ($Recursive) { $destGciParams['Recurse'] = $true }
        $destFiles = Get-ChildItem @destGciParams
        foreach ($df in $destFiles) {
            $relPath    = $df.FullName.Substring($DestDir.TrimEnd('\').Length + 1)
            $itemLabel  = "$Label/" + ($relPath -replace '\\', '/')
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
            $leakScript = Join-Path $RepoRoot 'scripts\ci\leak-scan.sh'
            if (Test-Path $leakScript) {
                $git = Get-Command git -ErrorAction SilentlyContinue
                $bash = $null
                if ($git) {
                    $candidate = Join-Path (Split-Path (Split-Path $git.Source -Parent) -Parent) 'bin\bash.exe'
                    if (Test-Path $candidate) { $bash = $candidate }
                }
                if (-not $bash) {
                    Write-Host '  NOTE: bash not found; skipping the leak scan.'
                } else {
                    & $bash $leakScript after/dotfiles after/sync-config.json | Out-Host
                    $leakExit = $LASTEXITCODE
                    if ($leakExit -eq 0) {
                        Write-Host '  Leak scan: clean.'
                    } elseif ($leakExit -eq 1) {
                        Write-Host '  WARNING: the leak scan found the lines above. Fix them before committing.'
                        $leakFound = 1
                    } else {
                        Write-Host 'ERROR: leak scan failed.' -ForegroundColor Red
                        return 1
                    }
                }
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

            Write-Host '  Nothing was written. Run export.bat to apply.'
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

# -- Import helpers ------------------------------------------------------------

function Copy-RepoFileToLocal {
    <#
    .SYNOPSIS
        Copies one repo file onto its local path (the plain, non-sanitized flow).
    .DESCRIPTION
        Creates the file when it is missing, compares by hash when it exists,
        and otherwise prompts before overwriting (unless -Force), keeping a .bak
        of the old file. Returns the status word: CREATED, UPDATED, UNCHANGED or SKIPPED.
    #>
    param(
        [string]$RepoFile,
        [string]$LocalFile,
        [string]$Label,
        [bool]$Force = $false
    )

    if (-not (Test-Path -LiteralPath $LocalFile)) {
        Copy-Item -LiteralPath $RepoFile -Destination $LocalFile -Force
        Write-StatusLine 'CREATED' $Label
        return 'CREATED'
    } elseif (Compare-FilesByHash -PathA $RepoFile -PathB $LocalFile) {
        Write-StatusLine 'UNCHANGED' $Label
        return 'UNCHANGED'
    } else {
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
    #>
    param(
        [string]$RepoDir,
        [string]$LocalDir,
        [string]$Label,
        [string[]]$ExcludePatterns,
        [bool]$Force = $false
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

    if (-not (Test-Path -LiteralPath $LocalDir)) {
        New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null
    }

    $applied = 0
    foreach ($file in (Get-ChildItem -LiteralPath $RepoDir -File -Recurse -Force)) {
        $rel = $file.FullName.Substring($RepoDir.TrimEnd('\').Length + 1)
        $itemLabel = "$Label/" + ($rel -replace '\\', '/')
        $localFile = Join-Path $LocalDir $rel

        if (Test-Excluded -FilePath $localFile -Patterns $ExcludePatterns) {
            Write-StatusLine 'SKIPPED' $itemLabel 'matches exclude pattern'
            continue
        }

        $localFileParent = Split-Path $localFile -Parent
        if (-not (Test-Path -LiteralPath $localFileParent)) {
            New-Item -ItemType Directory -Path $localFileParent -Force | Out-Null
        }

        $result = Copy-RepoFileToLocal -RepoFile $file.FullName -LocalFile $localFile -Label $itemLabel -Force $Force
        if ($result -eq 'CREATED' -or $result -eq 'UPDATED') { $applied++ }
    }

    if (Test-Path -LiteralPath $LocalDir) {
        foreach ($file in (Get-ChildItem -LiteralPath $LocalDir -File -Recurse -Force)) {
            $rel = $file.FullName.Substring($LocalDir.TrimEnd('\').Length + 1)
            $itemLabel = "$Label/" + ($rel -replace '\\', '/')
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

# -- Status output -------------------------------------------------------------

function Write-StatusLine {
    param([string]$Status, [string]$File, [string]$Note = '')
    $color = switch ($Status) {
        'ADDED'     { 'Green' }
        'MODIFIED'  { 'Yellow' }
        'CREATED'   { 'Green' }
        'UPDATED'   { 'Yellow' }
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
