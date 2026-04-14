#Requires -Version 5.1
<#
.SYNOPSIS
    Exports local config files into the repo for review.
.DESCRIPTION
    Compares local dotfiles against the repo copies using SHA256 content hashing.
    Copies changed files into dotfiles/ so the user can review and then run commit.bat.
.PARAMETER User
    Target Windows username. Defaults to the current user.
.EXAMPLE
    .\Export-Settings.ps1
    .\Export-Settings.ps1 -User johndoe
#>
param(
    [string]$User = $env:USERNAME
)

$ErrorActionPreference = 'Stop'

# ── Helpers ──────────────────────────────────────────────────────────────────

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
        'ADDED'     { 'Green' }
        'MODIFIED'  { 'Yellow' }
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

# ── Main ─────────────────────────────────────────────────────────────────────

Write-Host
Write-Host '╔══════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║        SyncSettings — EXPORT             ║' -ForegroundColor Cyan
Write-Host '╚══════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host

try {
    # Load config
    $repoRoot   = Split-Path $PSScriptRoot -Parent
    $configPath = Join-Path $repoRoot 'sync-config.json'
    if (-not (Test-Path $configPath)) {
        throw "sync-config.json not found at: $configPath"
    }
    $config = Get-Content $configPath -Raw | ConvertFrom-Json

    # Resolve target profile
    $profileRoot = Resolve-UserProfile -Username $User
    Write-Host "Target user   : $User" -ForegroundColor White
    Write-Host "Profile path  : $profileRoot" -ForegroundColor White
    Write-Host "Repo root     : $repoRoot" -ForegroundColor White
    Write-Host

    $results   = @()
    $changed   = 0

    foreach ($entry in $config.files) {
        $repoFile  = Join-Path $repoRoot ($entry.repoPath -replace '/', '\')
        $localFile = Resolve-LocalPath -Template $entry.localPath -ProfileRoot $profileRoot
        $label     = $entry.repoPath

        try {
            # Safety: check exclude patterns
            if (Test-Excluded -FilePath $localFile -Patterns $config.excludePatterns) {
                $results += [PSCustomObject]@{ Status = 'SKIPPED'; File = $label; Note = 'matches exclude pattern' }
                Write-StatusLine 'SKIPPED' $label 'matches exclude pattern'
                continue
            }

            # Local file must exist to export
            if (-not (Test-Path $localFile)) {
                $results += [PSCustomObject]@{ Status = 'SKIPPED'; File = $label; Note = 'local file not found' }
                Write-StatusLine 'SKIPPED' $label "local file not found: $localFile"
                continue
            }

            # Ensure repo destination folder exists
            $repoDir = Split-Path $repoFile -Parent
            if (-not (Test-Path $repoDir)) {
                New-Item -ItemType Directory -Path $repoDir -Force | Out-Null
            }

            if (-not (Test-Path $repoFile)) {
                # New file — not yet in repo
                Copy-Item -Path $localFile -Destination $repoFile -Force
                $results += [PSCustomObject]@{ Status = 'ADDED'; File = $label; Note = '' }
                Write-StatusLine 'ADDED' $label
                $changed++
            } elseif (Compare-ByHash -PathA $localFile -PathB $repoFile) {
                $results += [PSCustomObject]@{ Status = 'UNCHANGED'; File = $label; Note = '' }
                Write-StatusLine 'UNCHANGED' $label
            } else {
                Copy-Item -Path $localFile -Destination $repoFile -Force
                $results += [PSCustomObject]@{ Status = 'MODIFIED'; File = $label; Note = '' }
                Write-StatusLine 'MODIFIED' $label
                $changed++
            }
        } catch {
            $results += [PSCustomObject]@{ Status = 'ERROR'; File = $label; Note = $_.Exception.Message }
            Write-StatusLine 'ERROR' $label $_.Exception.Message
        }
    }

    Write-Host
    Write-Host ('─' * 50) -ForegroundColor DarkGray

    if ($changed -gt 0) {
        Write-Host "  $changed file(s) copied to the repo." -ForegroundColor Green
        Write-Host
        Write-Host '  Review the changes, then run  commit.bat  to commit and push.' -ForegroundColor Cyan
    } else {
        Write-Host '  Repo is up to date. No changes detected.' -ForegroundColor Green
    }

    Write-Host ('─' * 50) -ForegroundColor DarkGray
    Write-Host

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
