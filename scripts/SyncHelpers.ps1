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

function Resolve-LocalPath {
    param([string]$Template, [string]$ProfileRoot)
    $Template -replace '^~', $ProfileRoot
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
    # e.g., "Kiefer Fernandez Valladolid" before "Kiefer" (if both existed)
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
            # Detect if the line containing the placeholder uses \\ escaping.
            # If so, double the backslashes in the replacement value so the
            # resulting file keeps the same escaping convention (e.g., .gitconfig).
            $replacement = $actual
            if ($actual.Contains('\')) {
                $phIdx = $Content.IndexOf($rule.placeholder)
                $lineStart = $Content.LastIndexOf("`n", $phIdx) + 1
                $lineEnd   = $Content.IndexOf("`n", $phIdx)
                if ($lineEnd -lt 0) { $lineEnd = $Content.Length }
                $line = $Content.Substring($lineStart, $lineEnd - $lineStart)
                # Remove the placeholder itself before checking for \\
                $lineWithout = $line.Replace($rule.placeholder, '')
                if ($lineWithout.Contains('\\')) {
                    $replacement = $actual.Replace('\', '\\')
                }
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
