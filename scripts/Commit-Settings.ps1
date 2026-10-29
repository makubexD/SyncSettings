#Requires -Version 5.1
<#
.SYNOPSIS
    Commits sync-path changes on a branch and opens a pull request.
.DESCRIPTION
    Inspects git status for the sync paths, auto-generates a descriptive
    commit message, commits on a new branch, and opens a pull request.
.PARAMETER Message
    Custom commit message. If omitted, a message is generated from the changed files.
.PARAMETER Push
    Accepted for backward compatibility; commits now open a PR instead of pushing.
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

# -- Helpers ------------------------------------------------------------------

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

# -- Main ---------------------------------------------------------------------

Write-Host
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host '|        SyncSettings -- COMMIT             |' -ForegroundColor Cyan
Write-Host '+==========================================+' -ForegroundColor Cyan
Write-Host

$bodyFile = $null

try {
    # Verify git is available
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'git is not found in PATH. Please install Git and try again.'
    }

    # Verify the GitHub CLI is available (GH overrides the binary for tests).
    $gh = if ($env:GH) { $env:GH } else { 'gh' }
    if (-not (Get-Command $gh -ErrorAction SilentlyContinue)) {
        throw 'gh is not found in PATH. Install the GitHub CLI and run gh auth login.'
    }

    $repoRoot = Split-Path $PSScriptRoot -Parent
    Set-Location $repoRoot

    # Paths this script owns. `packages` is optional.
    $syncPaths = @('dotfiles', 'sync-config.json')
    if (Test-Path 'packages') {
        $syncPaths += 'packages'
    }

    # Refuse to run while unrelated changes are in the tree.
    $outsideArgs = @('.') + ($syncPaths | ForEach-Object { ':!' + $_ })
    $outside = git status --porcelain -- @outsideArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git status failed: $outside" }

    $outsideLines = @($outside | Where-Object { $_ -match '\S' })
    if ($outsideLines.Count -gt 0) {
        Write-Host '  Changes outside sync paths:' -ForegroundColor Red
        foreach ($line in $outsideLines) {
            Write-Host "    $line" -ForegroundColor Red
        }
        throw 'commit or stash changes outside dotfiles/ first.'
    }

    # Check for staged/unstaged changes in the sync paths.
    $statusLines = git status --porcelain -- @syncPaths 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git status failed: $statusLines" }

    $statusLines = @($statusLines | Where-Object { $_ -match '\S' })

    if ($statusLines.Count -eq 0) {
        Write-Host '  Nothing to commit -- dotfiles/ is clean.' -ForegroundColor Green
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
    Write-Host '  Commit message: ' -NoNewline
    Write-Host $commitMsg -ForegroundColor Cyan
    Write-Host

    # Only commit from master.
    $branchCurrent = git symbolic-ref --short HEAD 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git symbolic-ref failed: $branchCurrent" }
    if ($branchCurrent -ne 'master') {
        throw "run commit.bat from master (current: $branchCurrent)."
    }

    # Bring local master up to date; refuse to leave unpushed commits behind.
    git fetch origin master
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed.' }

    $counts = git rev-list --left-right --count HEAD...origin/master 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git rev-list failed: $counts" }

    $leftRight = @($counts -split '\s+' | Where-Object { $_ -ne '' })
    $ahead  = [int]$leftRight[0]
    $behind = [int]$leftRight[1]

    if ($behind -gt 0) {
        git merge --ff-only origin/master
        if ($LASTEXITCODE -ne 0) {
            throw 'master is behind origin; pull first.'
        }
    }

    if ($ahead -gt 0) {
        throw 'local master has unpushed commits; push or move them to a branch first.'
    }

    # Branch this sync off master.
    $branch = "sync/windows-$($env:COMPUTERNAME.ToLower())-$(Get-Date -Format 'yyyyMMdd-HHmm')"
    git switch -c $branch
    if ($LASTEXITCODE -ne 0) { throw 'git switch failed.' }

    # Stage and commit.
    git add -- @syncPaths
    if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }

    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed.' }

    # Push the branch.
    git push -u origin $branch
    if ($LASTEXITCODE -ne 0) {
        throw "push failed; you are on $branch. Fix and run: git push -u origin $branch"
    }

    # PR body.
    $bodyLines = @('## What changed', '')
    foreach ($line in $statusLines) {
        $bodyLines += "- ``$line``"
    }
    $bodyLines += ''
    $bodyLines += "Platform: windows · Host: $env:COMPUTERNAME"
    $bodyLines += ''
    $bodyLines += 'When the review is done, add the **`reviewed`** label.'

    $bodyText = $bodyLines -join "`n"
    $bodyFile = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($bodyFile, $bodyText)

    # Open the PR.
    $prUrl = & $gh pr create --base master --head $branch --title $commitMsg --body-file $bodyFile
    if ($LASTEXITCODE -ne 0) {
        throw "PR creation failed; branch $branch is pushed. Run: gh pr create --base master --head $branch"
    }

    # Return to master.
    git switch master
    if ($LASTEXITCODE -ne 0) { throw 'git switch failed.' }

    Write-Host "  PR opened: $prUrl" -ForegroundColor Green
    Write-Host "  Review it, add the 'reviewed' label, merge, then: git pull" -ForegroundColor White
    Write-Host
    exit 0

} catch {
    Write-Host
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($bodyFile) {
        Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
    }
}
