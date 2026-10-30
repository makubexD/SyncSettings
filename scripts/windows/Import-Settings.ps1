#Requires -Version 5.1
<#
.SYNOPSIS
    Imports repo config files to the local machine's user profile.
.DESCRIPTION
    Copies files from dotfiles/ to the target user's profile directories.
    Files with sanitizeRules have their placeholders filled with actual values
    (prompted or cached) before writing to disk.
    Creates .bak backups before overwriting existing files.
    Requests UAC elevation automatically when targeting another user's profile.
.PARAMETER User
    Target Windows username. Defaults to the current user.
.PARAMETER Force
    Skip per-file confirmation prompts and overwrite without asking.
.PARAMETER ResetValues
    Force re-prompting for all sanitized placeholder values, even if cached.
.EXAMPLE
    .\Import-Settings.ps1
    .\Import-Settings.ps1 -Force
    .\Import-Settings.ps1 -User johndoe
    .\Import-Settings.ps1 -ResetValues
#>
param(
    [string]$User = $env:USERNAME,
    [switch]$Force,
    [switch]$ResetValues
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\SyncHelpers.ps1"

# -- Elevation check ----------------------------------------------------------

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

try { $profileRoot = Resolve-UserProfile -Username $User } catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$isOtherUser = ($profileRoot -ne $env:USERPROFILE)

if ($isOtherUser -and -not (Test-IsAdmin)) {
    Write-Host
    Write-Host "  Targeting another user's profile requires administrator rights." -ForegroundColor Yellow
    Write-Host '  Requesting elevation -- please approve the UAC prompt...' -ForegroundColor Yellow
    Write-Host

    $argParts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"", "-User `"$User`"")
    if ($Force)       { $argParts += '-Force' }
    if ($ResetValues) { $argParts += '-ResetValues' }
    Start-Process powershell.exe -ArgumentList ($argParts -join ' ') -Verb RunAs -Wait
    exit 0
}

# -- Main ---------------------------------------------------------------------

Write-Host
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host '|        SyncSettings -- IMPORT             |' -ForegroundColor Cyan
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host

try {
    $configPath = Join-Path $repoRoot 'sync-config.json'
    if (-not (Test-Path $configPath)) {
        throw "sync-config.json not found at: $configPath"
    }
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    Assert-ValidPlatform -Files $config.files
    $config.files = @($config.files | Where-Object { Test-WindowsEntry $_ })

    Write-Host "  Target user   : $User" -ForegroundColor White
    Write-Host "  Profile path  : $profileRoot" -ForegroundColor White
    Write-Host "  Repo root     : $repoRoot" -ForegroundColor White
    if ($Force) { Write-Host '  (--Force: skipping confirmation prompts)' -ForegroundColor DarkYellow }
    Write-Host

    # Load cached user values
    $userValues   = Get-UserValues -RepoRoot $repoRoot
    $valuesDirty  = $false

    # -- Collect all sanitize rules and prompt once upfront ----------------
    $allRules = @()
    foreach ($entry in $config.files) {
        $hasSanitize = $entry.PSObject.Properties['sanitizeRules'] -and $entry.sanitizeRules.Count -gt 0
        if ($hasSanitize) {
            $repoFile = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
            if (Test-Path $repoFile) { $allRules += $entry.sanitizeRules }
        }
    }
    if ($allRules.Count -gt 0) {
        $seen  = @{}
        $unique = @()
        foreach ($r in $allRules) {
            if (-not $seen.ContainsKey($r.placeholder)) {
                $seen[$r.placeholder] = $true
                $unique += $r
            }
        }

        # Try to pre-populate from existing local files if no cache exists
        if (-not $ResetValues) {
            foreach ($entry in $config.files) {
                $hasSanitize = $entry.PSObject.Properties['sanitizeRules'] -and $entry.sanitizeRules.Count -gt 0
                if (-not $hasSanitize) { continue }
                $localFile = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
                $repoFile  = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
                if ((Test-Path $localFile) -and (Test-Path $repoFile)) {
                    $localContent = [IO.File]::ReadAllText($localFile)
                    $repoContent  = [IO.File]::ReadAllText($repoFile)
                    # For each rule, try to infer the value by comparing local vs repo line by line
                    $localLines = $localContent -split "`n"
                    $repoLines  = $repoContent -split "`n"
                    for ($i = 0; $i -lt [Math]::Min($localLines.Count, $repoLines.Count); $i++) {
                        foreach ($rule in $entry.sanitizeRules) {
                            $ph = $rule.placeholder
                            if ($repoLines[$i].Contains($ph) -and -not $localLines[$i].Contains($ph)) {
                                # Extract the actual value by comparing the two lines
                                $repoTrim  = $repoLines[$i].TrimEnd("`r")
                                $localTrim = $localLines[$i].TrimEnd("`r")
                                # Simple extraction: replace everything except the placeholder part
                                $before = $repoTrim.IndexOf($ph)
                                $after  = $before + $ph.Length
                                $prefix = $repoTrim.Substring(0, $before)
                                $suffix = $repoTrim.Substring($after)
                                if ($localTrim.StartsWith($prefix) -and $localTrim.EndsWith($suffix)) {
                                    $extracted = $localTrim.Substring($prefix.Length, $localTrim.Length - $prefix.Length - $suffix.Length)
                                    # The file holds the doubled form, so store the un-doubled value.
                                    if ($rule.PSObject.Properties['escapeBackslashes'] -and $rule.escapeBackslashes -eq $true) {
                                        $extracted = $extracted.Replace('\\', '\')
                                    }
                                    if ($extracted.Length -gt 0 -and (-not $userValues.ContainsKey($ph) -or $userValues[$ph].Length -eq 0)) {
                                        $userValues[$ph] = $extracted
                                        $valuesDirty = $true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        $rvParams = @{ Rules = $unique; UserValues = $userValues; Direction = 'import' }
        if ($ResetValues) { $rvParams.ForceAll = $true }
        Request-MissingValues @rvParams
        $valuesDirty = $true
    }

    # -- Process each file ------------------------------------------------
    $applied = 0

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

            # Repo file must exist
            if (-not (Test-Path $repoFile)) {
                Write-StatusLine 'SKIPPED' $label 'not found in repo'
                continue
            }

            $hasSanitize = $entry.PSObject.Properties['sanitizeRules'] -and $entry.sanitizeRules.Count -gt 0

            # Warn if the target folder structure doesn't exist (app may not be installed)
            $localDir = Split-Path $localFile -Parent
            if (-not (Test-Path $localDir)) {
                Write-StatusLine 'SKIPPED' $label "WARNING: target folder not found: $localDir"
                continue
            }

            if ($hasSanitize) {
                # -- Hydrate placeholders -----------------------------
                $repoContent = [IO.File]::ReadAllText($repoFile)
                $hydParams = @{ Content = $repoContent; Rules = $entry.sanitizeRules; UserValues = $userValues }
                $hydrated  = ConvertFrom-Sanitized @hydParams

                if (Test-Path $localFile) {
                    $localContent = [IO.File]::ReadAllText($localFile)
                    if (Compare-NormalizedContent $hydrated $localContent) {
                        Write-StatusLine 'UNCHANGED' $label
                        continue
                    }

                    # Files differ -- confirm unless -Force
                    if (-not $Force) {
                        Write-Host
                        Write-Host "  File differs: $localFile" -ForegroundColor Yellow
                        $answer = Read-Host '  Overwrite? [Y/n]'
                        if ($answer -ne '' -and $answer -notmatch '^[Yy]') {
                            Write-StatusLine 'SKIPPED' $label 'user skipped'
                            Write-Host
                            continue
                        }
                        Write-Host
                    }

                    # Backup existing file
                    Copy-Item -Path $localFile -Destination "$localFile.bak" -Force
                    Write-Utf8File -Path $localFile -Content $hydrated
                    Write-StatusLine 'UPDATED' $label "backup saved as $(Split-Path "$localFile.bak" -Leaf)"
                    $applied++
                } else {
                    Write-Utf8File -Path $localFile -Content $hydrated
                    Write-StatusLine 'CREATED' $label
                    $applied++
                }
            } else {
                # -- Direct copy --------------------------------------
                if (-not (Test-Path $localFile)) {
                    Copy-Item -Path $repoFile -Destination $localFile -Force
                    Write-StatusLine 'CREATED' $label
                    $applied++
                } elseif (Compare-FilesByHash -PathA $repoFile -PathB $localFile) {
                    Write-StatusLine 'UNCHANGED' $label
                } else {
                    if (-not $Force) {
                        Write-Host
                        Write-Host "  File differs: $localFile" -ForegroundColor Yellow
                        $answer = Read-Host '  Overwrite? [Y/n]'
                        if ($answer -ne '' -and $answer -notmatch '^[Yy]') {
                            Write-StatusLine 'SKIPPED' $label 'user skipped'
                            Write-Host
                            continue
                        }
                        Write-Host
                    }
                    Copy-Item -Path $localFile -Destination "$localFile.bak" -Force
                    Copy-Item -Path $repoFile  -Destination $localFile      -Force
                    Write-StatusLine 'UPDATED' $label "backup saved as $(Split-Path "$localFile.bak" -Leaf)"
                    $applied++
                }
            }

            # -- Auto-detect linked paths (import: repo -> local) --------
            $detectLinked = $entry.PSObject.Properties['detectLinkedPaths'] -and $entry.detectLinkedPaths -eq $true
            if ($detectLinked) {
                # Find the .linked/ folder in the repo for this entry
                $linkedBase = Join-Path $repoRoot (($entry.repoPath + '.linked') -replace '/', '\')
                if (Test-Path $linkedBase -PathType Container) {
                    $linkedDirs = Get-ChildItem -Path $linkedBase -Directory
                    foreach ($dir in $linkedDirs) {
                        $linkRepoFull = $dir.FullName
                        $linkLabel    = "$($entry.repoPath).linked/$($dir.Name)"

                        # Resolve local path: read the config file to find the original path
                        # that references this folder name
                        $linkLocal = $null
                        $repoContent = [IO.File]::ReadAllText($repoFile)
                        $detectedPaths = Find-LinkedPaths -Content $repoContent -SkipExistenceCheck
                        foreach ($dp in $detectedPaths) {
                            $resolved = Resolve-UnixPath -Path $dp
                            if ((Split-Path $resolved -Leaf) -eq $dir.Name) {
                                $linkLocal = $resolved
                                break
                            }
                        }

                        if (-not $linkLocal) {
                            # Fallback: couldn't find the path in the file, skip
                            Write-StatusLine 'SKIPPED' "$linkLabel/" 'could not resolve local path from file content'
                            continue
                        }

                        if (-not (Test-Path $linkLocal)) {
                            Write-Host "  Creating linked directory: $linkLocal" -ForegroundColor Cyan
                        }

                        $syncParams = @{
                            SourceDir       = $linkRepoFull
                            DestDir         = $linkLocal
                            Label           = $linkLabel
                            ExcludePatterns = $config.excludePatterns
                            Recursive       = $false
                        }
                        $linkStats = Sync-LinkedDirectory @syncParams
                        $applied += ($linkStats.added + $linkStats.modified)
                    }
                }
            }
        } catch {
            Write-StatusLine 'ERROR' $label $_.Exception.Message
        }
    }

    # Save user values cache
    if ($valuesDirty) {
        Save-UserValues -RepoRoot $repoRoot -Values $userValues
    }

    Write-Host
    Write-Host ('-' * 50) -ForegroundColor DarkGray

    if ($applied -gt 0) {
        Write-Host "  $applied file(s) applied to $profileRoot" -ForegroundColor Green
    } else {
        Write-Host '  No files were changed. Machine is already up to date.' -ForegroundColor Green
    }

    Write-Host ('-' * 50) -ForegroundColor DarkGray
    Write-Host

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
