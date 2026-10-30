#Requires -Version 5.1
<#
.SYNOPSIS
    Exports local config files into the repo for review.
.DESCRIPTION
    Compares local dotfiles against the repo copies by content.
    Files with sanitizeRules have sensitive values replaced with placeholders
    before writing to the repo (e.g., your name becomes <YOUR_NAME>).
    Files without sanitizeRules are compared by SHA256 hash and copied as-is.
.PARAMETER User
    Target Windows username. Defaults to the current user.
.PARAMETER ResetValues
    Force re-prompting for all sanitized placeholder values, even if cached.
.EXAMPLE
    .\Export-Settings.ps1
    .\Export-Settings.ps1 -User johndoe
    .\Export-Settings.ps1 -ResetValues
#>
param(
    [string]$User = $env:USERNAME,
    [switch]$ResetValues
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\SyncHelpers.ps1"

# -- Main ---------------------------------------------------------------------

Write-Host
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host '|        SyncSettings -- EXPORT             |' -ForegroundColor Cyan
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host

try {
    $repoRoot   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $configPath = Join-Path $repoRoot 'sync-config.json'
    if (-not (Test-Path $configPath)) {
        throw "sync-config.json not found at: $configPath"
    }
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    Assert-ValidPlatform -Files $config.files
    $config.files = @($config.files | Where-Object { Test-WindowsEntry $_ })

    $profileRoot = Resolve-UserProfile -Username $User
    Write-Host "  Target user   : $User" -ForegroundColor White
    Write-Host "  Profile path  : $profileRoot" -ForegroundColor White
    Write-Host "  Repo root     : $repoRoot" -ForegroundColor White
    Write-Host

    # Load cached user values for sanitization
    $userValues   = Get-UserValues -RepoRoot $repoRoot
    $valuesDirty  = $false
    $changed      = 0
    $skipped      = 0

    # -- Collect all sanitize rules and prompt once upfront ----------------
    # Only collect rules for entries whose local file actually exists —
    # no point prompting for values when the file isn't on this machine yet.
    $allRules = @()
    foreach ($entry in $config.files) {
        $hasSanitize = $entry.PSObject.Properties['sanitizeRules'] -and $entry.sanitizeRules.Count -gt 0
        if ($hasSanitize) {
            $localFile = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
            if (Test-Path $localFile) {
                $allRules += $entry.sanitizeRules
            }
        }
    }
    if ($allRules.Count -gt 0) {
        # Deduplicate rules by placeholder name
        $seen  = @{}
        $unique = @()
        foreach ($r in $allRules) {
            if (-not $seen.ContainsKey($r.placeholder)) {
                $seen[$r.placeholder] = $true
                $unique += $r
            }
        }
        $rvParams = @{ Rules = $unique; UserValues = $userValues; Direction = 'export' }
        if ($ResetValues) { $rvParams.ForceAll = $true }
        Request-MissingValues @rvParams
        $valuesDirty = $true
    }

    # -- Process each file ------------------------------------------------
    foreach ($entry in $config.files) {
        $repoFile  = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
        $localFile = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
        $label     = $entry.repoPath

        try {
            # Exclude-pattern safety check
            if (Test-Excluded -FilePath $localFile -Patterns $config.excludePatterns) {
                Write-StatusLine 'SKIPPED' $label 'matches exclude pattern'
                continue
            }

            # Local file must exist to export
            if (-not (Test-Path $localFile)) {
                $parentDir = Split-Path $localFile -Parent
                if (-not (Test-Path $parentDir)) {
                    Write-StatusLine 'SKIPPED' $label "WARNING: folder not found: $parentDir"
                } else {
                    Write-StatusLine 'SKIPPED' $label "WARNING: local file not found: $localFile"
                }
                $skipped++
                continue
            }

            # Ensure repo destination folder exists
            $repoDir = Split-Path $repoFile -Parent
            if (-not (Test-Path $repoDir)) {
                New-Item -ItemType Directory -Path $repoDir -Force | Out-Null
            }

            $hasSanitize = $entry.PSObject.Properties['sanitizeRules'] -and $entry.sanitizeRules.Count -gt 0

            if ($hasSanitize) {
                # -- Sanitized comparison -----------------------------
                $localContent = [IO.File]::ReadAllText($localFile)
                $sanParams = @{ Content = $localContent; Rules = $entry.sanitizeRules; UserValues = $userValues }
                $sanitized = ConvertTo-Sanitized @sanParams

                if (Test-Path $repoFile) {
                    $repoContent = [IO.File]::ReadAllText($repoFile)
                    if (Compare-NormalizedContent $sanitized $repoContent) {
                        Write-StatusLine 'UNCHANGED' $label
                    } else {
                        Write-Utf8File -Path $repoFile -Content $sanitized
                        Write-StatusLine 'MODIFIED' $label 'sanitized'
                        $changed++
                    }
                } else {
                    Write-Utf8File -Path $repoFile -Content $sanitized
                    Write-StatusLine 'ADDED' $label 'sanitized'
                    $changed++
                }
            } else {
                # -- Direct hash comparison ---------------------------
                if (-not (Test-Path $repoFile)) {
                    Copy-Item -Path $localFile -Destination $repoFile -Force
                    Write-StatusLine 'ADDED' $label
                    $changed++
                } elseif (Compare-FilesByHash -PathA $localFile -PathB $repoFile) {
                    Write-StatusLine 'UNCHANGED' $label
                } else {
                    Copy-Item -Path $localFile -Destination $repoFile -Force
                    Write-StatusLine 'MODIFIED' $label
                    $changed++
                }
            }

            # -- Auto-detect linked paths (export: local -> repo) --------
            $detectLinked = $entry.PSObject.Properties['detectLinkedPaths'] -and $entry.detectLinkedPaths -eq $true
            if ($detectLinked -and (Test-Path $localFile)) {
                $fileContent = [IO.File]::ReadAllText($localFile)
                $detectedPaths = Find-LinkedPaths -Content $fileContent
                foreach ($detectedPath in $detectedPaths) {
                    $linkLocal    = Resolve-UnixPath -Path $detectedPath
                    $linkRepo     = Resolve-LinkedRepoPath -ParentRepoPath $entry.repoPath -LinkedLocalPath $detectedPath
                    $linkRepoFull = Join-Path $repoRoot ($linkRepo -replace '/', '\')
                    $linkLabel    = $linkRepo
                    $syncParams = @{
                        SourceDir       = $linkLocal
                        DestDir         = $linkRepoFull
                        Label           = $linkLabel
                        ExcludePatterns = $config.excludePatterns
                        Recursive       = $false
                    }
                    $linkStats = Sync-LinkedDirectory @syncParams
                    $changed += ($linkStats.added + $linkStats.modified)
                }
            }
        } catch {
            Write-StatusLine 'ERROR' $label $_.Exception.Message
        }
    }

    # Save user values cache if we collected any
    if ($valuesDirty) {
        Save-UserValues -RepoRoot $repoRoot -Values $userValues
    }

    Write-Host
    Write-Host ('-' * 50) -ForegroundColor DarkGray

    if ($changed -gt 0) {
        Write-Host "  $changed file(s) copied to the repo." -ForegroundColor Green
        Write-Host
        Write-Host '  Review the changes, then run  commit.bat  to commit and push.' -ForegroundColor Cyan
    } else {
        Write-Host '  Repo is up to date. No changes detected.' -ForegroundColor Green
        if ($skipped -gt 0) {
            Write-Host
            Write-Host "  Note: $skipped file(s) skipped because they don't exist locally." -ForegroundColor DarkYellow
            Write-Host '  If this is a new machine, run  import.bat  to apply repo settings first.' -ForegroundColor DarkYellow
        }
    }

    Write-Host ('-' * 50) -ForegroundColor DarkGray
    Write-Host

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
