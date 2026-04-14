#Requires -Version 5.1
<#
.SYNOPSIS
    Imports repo config files to the local machine's user profile.
.DESCRIPTION
    Copies files from dotfiles/ to the target user's profile directories.
    Creates .bak backups before overwriting existing files.
    Requests UAC elevation automatically when targeting another user's profile.
.PARAMETER User
    Target Windows username. Defaults to the current user.
.PARAMETER Force
    Skip per-file confirmation prompts and overwrite without asking.
.EXAMPLE
    .\Import-Settings.ps1
    .\Import-Settings.ps1 -Force
    .\Import-Settings.ps1 -User johndoe
    .\Import-Settings.ps1 -User johndoe -Force
#>
param(
    [string]$User  = $env:USERNAME,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ── Helpers ──────────────────────────────────────────────────────────────────

function Test-IsAdmin {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

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

function Test-Excluded {
    param([string]$FilePath, [string[]]$Patterns)
    $leaf = Split-Path $FilePath -Leaf
    foreach ($p in $Patterns) {
        if ($leaf -like $p -or $FilePath -like "*\$p") { return $true }
    }
    return $false
}

function Compare-ByHash {
    param([string]$PathA, [string]$PathB)
    if (-not (Test-Path $PathA) -or -not (Test-Path $PathB)) { return $false }
    $a = (Get-FileHash -Path $PathA -Algorithm SHA256).Hash
    $b = (Get-FileHash -Path $PathB -Algorithm SHA256).Hash
    return $a -eq $b
}

function Write-StatusLine {
    param([string]$Status, [string]$File, [string]$Note = '')
    $color = switch ($Status) {
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

# ── Elevation check ───────────────────────────────────────────────────────────

$repoRoot = Split-Path $PSScriptRoot -Parent

# Resolve profile before elevation check (need to know if it's "other user")
try { $profileRoot = Resolve-UserProfile -Username $User } catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$isOtherUser = ($profileRoot -ne $env:USERPROFILE)

if ($isOtherUser -and -not (Test-IsAdmin)) {
    Write-Host
    Write-Host "  Targeting another user's profile requires administrator rights." -ForegroundColor Yellow
    Write-Host '  Requesting elevation — please approve the UAC prompt...' -ForegroundColor Yellow
    Write-Host

    $forceArg = if ($Force) { '-Force' } else { '' }
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -User `"$User`" $forceArg"
    Start-Process powershell.exe -ArgumentList $args -Verb RunAs -Wait
    exit 0
}

# ── Main ─────────────────────────────────────────────────────────────────────

Write-Host
Write-Host '╔══════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║        SyncSettings — IMPORT             ║' -ForegroundColor Cyan
Write-Host '╚══════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host

try {
    $configPath = Join-Path $repoRoot 'sync-config.json'
    if (-not (Test-Path $configPath)) {
        throw "sync-config.json not found at: $configPath"
    }
    $config = Get-Content $configPath -Raw | ConvertFrom-Json

    Write-Host "Target user   : $User" -ForegroundColor White
    Write-Host "Profile path  : $profileRoot" -ForegroundColor White
    Write-Host "Repo root     : $repoRoot" -ForegroundColor White
    if ($Force) { Write-Host '  (--Force: skipping confirmation prompts)' -ForegroundColor DarkYellow }
    Write-Host

    $applied = 0

    foreach ($entry in $config.files) {
        $repoFile  = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
        $localFile = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
        $label     = $entry.repoPath

        try {
            # Safety: check exclude patterns
            if (Test-Excluded -FilePath $localFile -Patterns $config.excludePatterns) {
                Write-StatusLine 'SKIPPED' $label 'matches exclude pattern'
                continue
            }

            # Repo file must exist
            if (-not (Test-Path $repoFile)) {
                Write-StatusLine 'SKIPPED' $label "not found in repo: $($entry.repoPath)"
                continue
            }

            # Ensure local destination folder exists
            $localDir = Split-Path $localFile -Parent
            if (-not (Test-Path $localDir)) {
                New-Item -ItemType Directory -Path $localDir -Force | Out-Null
            }

            if (-not (Test-Path $localFile)) {
                # Destination doesn't exist — just create it
                Copy-Item -Path $repoFile -Destination $localFile -Force
                Write-StatusLine 'CREATED' $label
                $applied++
            } elseif (Compare-ByHash -PathA $repoFile -PathB $localFile) {
                Write-StatusLine 'UNCHANGED' $label
            } else {
                # Files differ — confirm unless -Force
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
                $backupPath = "$localFile.bak"
                Copy-Item -Path $localFile -Destination $backupPath -Force
                Copy-Item -Path $repoFile  -Destination $localFile  -Force
                Write-StatusLine 'UPDATED' $label "backup saved as $(Split-Path $backupPath -Leaf)"
                $applied++
            }
        } catch {
            Write-StatusLine 'ERROR' $label $_.Exception.Message
        }
    }

    Write-Host
    Write-Host ('─' * 50) -ForegroundColor DarkGray

    if ($applied -gt 0) {
        Write-Host "  $applied file(s) applied to $profileRoot" -ForegroundColor Green
    } else {
        Write-Host '  No files were changed. Machine is already up to date.' -ForegroundColor Green
    }

    Write-Host ('─' * 50) -ForegroundColor DarkGray
    Write-Host

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
