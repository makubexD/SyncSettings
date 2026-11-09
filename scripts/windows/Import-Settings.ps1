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
.PARAMETER Check
    Report what an import would change, and write nothing.
.EXAMPLE
    .\Import-Settings.ps1
    .\Import-Settings.ps1 -Force
    .\Import-Settings.ps1 -User johndoe
    .\Import-Settings.ps1 -ResetValues
    .\Import-Settings.ps1 -Check
#>
param(
    [string]$User = $env:USERNAME,
    [switch]$Force,
    [switch]$ResetValues,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

if ($Check -and $ResetValues) {
    Write-Host 'ERROR: -Check cannot be combined with -ResetValues.' -ForegroundColor Red
    exit 1
}

. "$PSScriptRoot\SyncHelpers.ps1"

# -- Elevation check ----------------------------------------------------------

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

try { $profileRoot = Resolve-UserProfile -Username $User } catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$isOtherUser = ($profileRoot -ne $env:USERPROFILE)

if ($Check -and $isOtherUser) {
    Write-Host 'ERROR: -Check works on your own profile only.' -ForegroundColor Red
    exit 1
}

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
if ($Check) {
    Write-Host '|     SyncSettings -- IMPORT CHECK          |' -ForegroundColor Cyan
} else {
    Write-Host '|        SyncSettings -- IMPORT             |' -ForegroundColor Cyan
}
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host

try {
    $configPath = Join-Path $repoRoot 'sync-config.json'
    if (-not (Test-Path $configPath)) {
        throw "sync-config.json not found at: $configPath"
    }
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    Assert-ValidPlatform -Files $config.files
    Assert-SafePaths -RepoRoot $repoRoot -Files $config.files
    $config.files = @(Select-WindowsEntries -Files $config.files)

    if (-not $Check -and (Test-RepoUpToDate -RepoRoot $repoRoot)) { exit 0 }

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

        if ($Check) {
            # Never prompt or save here: fall back to the rule default, then its
            # defaultEnv variable, in memory only, in the order the prompt shows.
            foreach ($rule in $unique) {
                $cached = $userValues[$rule.placeholder]
                if (-not $cached -or $cached.Length -eq 0) {
                    if ($rule.PSObject.Properties['default'] -and $rule.default) {
                        $userValues[$rule.placeholder] = $rule.default
                    } elseif ($rule.PSObject.Properties['defaultEnv'] -and $rule.defaultEnv) {
                        $envDefault = [Environment]::GetEnvironmentVariable($rule.defaultEnv)
                        if ($envDefault) { $userValues[$rule.placeholder] = $envDefault }
                    }
                }
            }
            $valuesDirty = $false
        } else {
            $rvParams = @{ Rules = $unique; UserValues = $userValues; Direction = 'import' }
            if ($ResetValues) { $rvParams.ForceAll = $true }
            Request-MissingValues @rvParams
            $valuesDirty = $true
        }
    }

    # -- Process each file ------------------------------------------------
    $applied = 0
    $changed = 0
    $errors  = 0

    foreach ($entry in $config.files) {
        $repoFile  = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
        $localFile = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
        $label     = $entry.repoPath

        try {
            # Directory entries sync the whole folder recursively (import never
            # deletes), before the single-file logic below.
            if ($entry.PSObject.Properties['type'] -and $entry.type -eq 'dir') {
                $repoDir  = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
                $localDir = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
                $dirCount = Import-DirEntry -RepoDir $repoDir -LocalDir $localDir -Label $label -ExcludePatterns $config.excludePatterns -Force ([bool]$Force) -Check ([bool]$Check) -ErrorCount ([ref]$errors)
                if ($Check) { $changed += $dirCount } else { $applied += $dirCount }
                continue
            }

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
                if ($Check) {
                    $missingValue = $false
                    foreach ($rule in $entry.sanitizeRules) {
                        $v = $userValues[$rule.placeholder]
                        if (-not $v -or $v.Length -eq 0) { $missingValue = $true; break }
                    }
                    if ($missingValue) {
                        Write-StatusLine 'SKIPPED' $label 'needs values: run mksync setup'
                        $changed++
                        continue
                    }
                }

                $repoContent = [IO.File]::ReadAllText($repoFile)
                $hydParams = @{ Content = $repoContent; Rules = $entry.sanitizeRules; UserValues = $userValues }
                $hydrated  = ConvertFrom-Sanitized @hydParams

                if (Test-Path $localFile) {
                    $localContent = [IO.File]::ReadAllText($localFile)
                    if (Compare-NormalizedContent $hydrated $localContent) {
                        Write-StatusLine 'UNCHANGED' $label
                        continue
                    }

                    if ($Check) {
                        Write-StatusLine 'UPDATE' $label
                        $changed++
                    } else {
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
                    }
                } else {
                    if ($Check) {
                        Write-StatusLine 'CREATE' $label
                        $changed++
                    } else {
                        Write-Utf8File -Path $localFile -Content $hydrated
                        Write-StatusLine 'CREATED' $label
                        $applied++
                    }
                }
            } else {
                # -- Direct copy --------------------------------------
                $result = Copy-RepoFileToLocal -RepoFile $repoFile -LocalFile $localFile -Label $label -Force ([bool]$Force) -Check ([bool]$Check)
                if ($Check) {
                    if ($result -eq 'CREATE' -or $result -eq 'UPDATE') { $changed++ }
                } else {
                    # A skipped file also skips its linked paths, as before the refactor.
                    if ($result -eq 'SKIPPED') { continue }
                    if ($result -eq 'CREATED' -or $result -eq 'UPDATED') { $applied++ }
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

                        if (-not $Check -and -not (Test-Path $linkLocal)) {
                            Write-Host "  Creating linked directory: $linkLocal" -ForegroundColor Cyan
                        }

                        $linkCount = Import-LinkedDirectory -SourceDir $linkRepoFull -DestDir $linkLocal -Label $linkLabel -ExcludePatterns $config.excludePatterns -Force ([bool]$Force) -Check ([bool]$Check) -ErrorCount ([ref]$errors)
                        if ($Check) { $changed += $linkCount } else { $applied += $linkCount }
                    }
                }
            }
        } catch {
            Write-StatusLine 'ERROR' $label $_.Exception.Message
            $errors++
        }
    }

    # Save user values cache
    if ($valuesDirty -and -not $Check) {
        Save-UserValues -RepoRoot $repoRoot -Values $userValues
    }

    Write-Host
    Write-Host ('-' * 50) -ForegroundColor DarkGray

    if ($Check) {
        if ($errors -gt 0) {
            Write-Host "  $errors error(s); see the ERROR lines above." -ForegroundColor Red
            $exitCode = 1
        } elseif ($changed -eq 0) {
            Write-Host '  This machine matches the repo.' -ForegroundColor Green
            $exitCode = 0
        } else {
            Write-Host "  $changed file(s) would change. mksync pull overwrites them (each keeps a .bak)." -ForegroundColor Yellow
            Write-Host '  If you changed them on this machine, run mksync push first.' -ForegroundColor Yellow
            $exitCode = 3
        }
    } elseif ($applied -gt 0) {
        Write-Host "  $applied file(s) applied to $profileRoot" -ForegroundColor Green
    } else {
        Write-Host '  No files were changed. Machine is already up to date.' -ForegroundColor Green
    }

    Write-Host ('-' * 50) -ForegroundColor DarkGray
    Write-Host

    if ($Check) { exit $exitCode }

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
