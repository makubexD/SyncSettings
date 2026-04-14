#Requires -Version 5.1
<#
.SYNOPSIS
    Commits and optionally pushes changes in dotfiles/ to the remote repo.
.DESCRIPTION
    Inspects git status for the dotfiles/ folder, auto-generates a descriptive
    commit message, and optionally pushes to the remote.
.PARAMETER Message
    Custom commit message. If omitted, a message is generated from the changed files.
.PARAMETER Push
    Push to the remote after committing.
.EXAMPLE
    .\Commit-Settings.ps1
    .\Commit-Settings.ps1 -Push
    .\Commit-Settings.ps1 -Message "update work laptop settings" -Push
#>
param(
    [string]$Message = '',
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

# ── Helpers ──────────────────────────────────────────────────────────────────

function Build-CommitMessage {
    param([string[]]$StatusLines)

    $added    = @()
    $modified = @()
    $deleted  = @()

    foreach ($line in $StatusLines) {
        if ($line.Length -lt 4) { continue }
        $code = $line.Substring(0, 2).Trim()
        $file = $line.Substring(3).Trim()
        $name = Split-Path $file -Leaf

        switch -Regex ($code) {
            '^A$'  { $added    += $name }
            '^\?\?$' { $added  += $name }
            '^M$'  { $modified += $name }
            '^D$'  { $deleted  += $name }
        }
    }

    $parts = @()
    if ($added.Count    -gt 0) { $parts += "add $($added    -join ', ')" }
    if ($modified.Count -gt 0) { $parts += "update $($modified -join ', ')" }
    if ($deleted.Count  -gt 0) { $parts += "remove $($deleted  -join ', ')" }

    if ($parts.Count -eq 0) { return 'sync: update config files' }

    $msg = 'sync: ' + ($parts -join '; ')

    # Keep under 72 chars (git convention)
    if ($msg.Length -gt 72) {
        $total = $added.Count + $modified.Count + $deleted.Count
        $msg = "sync: update $total config file(s)"
    }

    return $msg
}

# ── Main ─────────────────────────────────────────────────────────────────────

Write-Host
Write-Host '╔══════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║        SyncSettings — COMMIT             ║' -ForegroundColor Cyan
Write-Host '╚══════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host

try {
    # Verify git is available
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'git is not found in PATH. Please install Git and try again.'
    }

    $repoRoot = Split-Path $PSScriptRoot -Parent
    Set-Location $repoRoot

    # Check for staged/unstaged changes in dotfiles/
    $statusLines = git status --porcelain -- dotfiles/ 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git status failed: $statusLines" }

    $statusLines = @($statusLines | Where-Object { $_ -match '\S' })

    if ($statusLines.Count -eq 0) {
        Write-Host '  Nothing to commit — dotfiles/ is clean.' -ForegroundColor Green
        Write-Host
        exit 0
    }

    Write-Host '  Changed files:' -ForegroundColor White
    foreach ($line in $statusLines) {
        Write-Host "    $line" -ForegroundColor Yellow
    }
    Write-Host

    # Build commit message
    $commitMsg = if ($Message) { $Message } else { Build-CommitMessage -StatusLines $statusLines }
    Write-Host "  Commit message: " -NoNewline
    Write-Host $commitMsg -ForegroundColor Cyan
    Write-Host

    # Stage dotfiles/
    git add dotfiles/
    if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }

    # Commit
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed.' }

    Write-Host
    Write-Host '  Committed successfully.' -ForegroundColor Green

    # Push
    if (-not $Push) {
        Write-Host
        $answer = Read-Host '  Push to remote? [Y/n]'
        if ($answer -eq '' -or $answer -match '^[Yy]') { $Push = $true }
    }

    if ($Push) {
        Write-Host '  Pushing...' -ForegroundColor White
        git push
        if ($LASTEXITCODE -ne 0) {
            Write-Host '  Push failed. Make sure a remote is configured: git remote add origin <url>' -ForegroundColor Red
            exit 1
        }
        Write-Host '  Pushed successfully.' -ForegroundColor Green
    }

    Write-Host

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
