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
    if (-not (Test-Path $PathA) -or -not (Test-Path $PathB)) { return $false }
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

            # Show default: cached value or rule default
            $defaultVal = $null
            if ($cached -and $cached.Length -gt 0) {
                $defaultVal = $cached
            } elseif ($rule.PSObject.Properties['default'] -and $rule.default) {
                $defaultVal = $rule.default
            }

            if ($defaultVal) {
                $promptText += " [$defaultVal]"
            }

            $value = Read-Host $promptText
            if (-not $value -and $defaultVal) {
                $value = $defaultVal
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
    # Returns hashtable: { added, modified, unchanged, skipped }
    param(
        [string]$SourceDir,
        [string]$DestDir,
        [string]$Label,
        [string[]]$ExcludePatterns,
        [bool]$Recursive = $false
    )

    $stats = @{ added = 0; modified = 0; unchanged = 0; skipped = 0 }

    if (-not (Test-Path $SourceDir)) {
        Write-StatusLine 'SKIPPED' "$Label/" "WARNING: source directory not found: $SourceDir"
        return $stats
    }

    if (-not (Test-Path $DestDir)) {
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    }

    $gciParams = @{ Path = $SourceDir; File = $true }
    if ($Recursive) { $gciParams['Recurse'] = $true }
    $sourceFiles = Get-ChildItem @gciParams

    foreach ($file in $sourceFiles) {
        $relPath  = $file.FullName.Substring($SourceDir.TrimEnd('\').Length + 1)
        $destFile = Join-Path $DestDir $relPath

        if (Test-Excluded -FilePath $file.FullName -Patterns $ExcludePatterns) {
            Write-StatusLine 'SKIPPED' "$Label/$relPath" 'matches exclude pattern'
            $stats.skipped++
            continue
        }

        $destDir2 = Split-Path $destFile -Parent
        if (-not (Test-Path $destDir2)) {
            New-Item -ItemType Directory -Path $destDir2 -Force | Out-Null
        }

        if (-not (Test-Path $destFile)) {
            Copy-Item -Path $file.FullName -Destination $destFile -Force
            Write-StatusLine 'ADDED' "$Label/$relPath"
            $stats.added++
        } elseif (Compare-FilesByHash -PathA $file.FullName -PathB $destFile) {
            Write-StatusLine 'UNCHANGED' "$Label/$relPath"
            $stats.unchanged++
        } else {
            Copy-Item -Path $file.FullName -Destination $destFile -Force
            Write-StatusLine 'MODIFIED' "$Label/$relPath"
            $stats.modified++
        }
    }

    # Remove orphans: files in dest that no longer exist in source
    if (Test-Path $DestDir) {
        $destGciParams = @{ Path = $DestDir; File = $true }
        if ($Recursive) { $destGciParams['Recurse'] = $true }
        $destFiles = Get-ChildItem @destGciParams
        foreach ($df in $destFiles) {
            $relPath    = $df.FullName.Substring($DestDir.TrimEnd('\').Length + 1)
            $sourceFile = Join-Path $SourceDir $relPath
            if (-not (Test-Path $sourceFile)) {
                Remove-Item $df.FullName -Force
                Write-StatusLine 'REMOVED' "$Label/$relPath" 'no longer in source'
            }
        }
    }

    return $stats
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
        'ERROR'     { 'Red' }
        default     { 'White' }
    }
    $label = $Status.PadRight(10)
    Write-Host "  [$label] " -ForegroundColor $color -NoNewline
    Write-Host $File -NoNewline
    if ($Note) { Write-Host "  ($Note)" -ForegroundColor DarkGray } else { Write-Host }
}
