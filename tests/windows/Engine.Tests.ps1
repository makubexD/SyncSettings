#Requires -Version 5.1
# Baseline engine tests for the Windows (PowerShell) engine, mirroring
# tests/linux/engine.sh for the single windows fixture entry. Run from the repo
# root with: Invoke-Pester -Path tests/windows -CI

# Pester 5 runs top-level code only during discovery, so paths and helpers live
# in BeforeAll to exist when the tests run.
BeforeAll {
    $Script:TestRepo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $Script:Fixtures = Join-Path $Script:TestRepo 'tests\fixtures'

    # -- Helpers ---------------------------------------------------------------

    function Copy-EngineToRepo {
        $script:RepoDir = Join-Path $script:T 'repo'
        $winDir = Join-Path $script:RepoDir 'scripts\windows'
        $null = New-Item -ItemType Directory -Path $winDir -Force
        Copy-Item -Path (Join-Path $Script:TestRepo 'scripts\windows\*.ps1') -Destination $winDir -Force
        Copy-Item -Path (Join-Path $Script:Fixtures 'sync-config.json') -Destination (Join-Path $script:RepoDir 'sync-config.json') -Force
        Copy-Item -Path (Join-Path $Script:Fixtures 'user-values.json') -Destination (Join-Path $script:RepoDir '.user-values.json') -Force
    }

    function Copy-RepoDotfiles {
        $dotfiles = Join-Path $script:RepoDir 'dotfiles'
        $null = New-Item -ItemType Directory -Path $dotfiles -Force
        Copy-Item -Path (Join-Path $Script:Fixtures 'repo\dotfiles\*') -Destination $dotfiles -Recurse -Force
    }

    function Copy-HomeFiles {
        $null = New-Item -ItemType Directory -Path $script:HomeDir -Force
        Copy-Item -Path (Join-Path $Script:Fixtures 'home\*') -Destination $script:HomeDir -Recurse -Force
    }

    # Makes $script:RepoDir a git repo on master with a local bare origin.
    # git writes to stderr, which must not fail the test.
    function New-GitRepo {
        $ErrorActionPreference = 'Continue'
        git -C $script:RepoDir init -q -b master 2>$null
        git -C $script:RepoDir add -A 2>$null
        git -C $script:RepoDir -c user.name=t -c user.email=t@example.com commit -q -m init 2>$null
        $origin = Join-Path $script:T 'origin.git'
        git init -q --bare -b master $origin 2>$null
        git -C $script:RepoDir remote add origin $origin 2>$null
        git -C $script:RepoDir push -q origin master 2>$null
    }

    function Invoke-Engine {
        param([string]$ScriptName, [switch]$Force)
        $script:EngineScript = Join-Path $script:RepoDir "scripts\windows\$ScriptName"
        if ($Force) {
            $script:EngineOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript -Force 2>&1 | Out-String
        } else {
            $script:EngineOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript 2>&1 | Out-String
        }
        $script:EngineExit = $LASTEXITCODE
    }

    # Same as Invoke-Engine, but with stdin redirected so Test-Interactive is false.
    function Invoke-EnginePiped {
        param([string]$ScriptName, [switch]$Force)
        $script:EngineScript = Join-Path $script:RepoDir "scripts\windows\$ScriptName"
        if ($Force) {
            $script:EngineOut = "" | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript -Force 2>&1 | Out-String
        } else {
            $script:EngineOut = "" | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript 2>&1 | Out-String
        }
        $script:EngineExit = $LASTEXITCODE
    }

    # Runs Import-Settings.ps1 -Check with stdin redirected, so it can never prompt.
    function Invoke-ImportCheck {
        param([switch]$ResetValues, [string]$User = '')
        $script:EngineScript = Join-Path $script:RepoDir 'scripts\windows\Import-Settings.ps1'
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:EngineScript, '-Check')
        if ($ResetValues) { $argList += '-ResetValues' }
        if ($User) { $argList += @('-User', $User) }
        $script:EngineOut = "" | & powershell.exe @argList 2>&1 | Out-String
        $script:EngineExit = $LASTEXITCODE
    }

    # Builds a regex for Write-StatusLine output: "[WORD      ] label" with an
    # optional "  (note)" suffix. Labels use forward slashes (the repoPath).
    function Get-StatusPattern {
        param([string]$Word, [string]$Label, [string]$Note = '')
        $pattern = '\[' + [regex]::Escape($Word) + '\s*\] ' + [regex]::Escape($Label)
        if ($Note) {
            $pattern = $pattern + '  \(' + [regex]::Escape($Note) + '\)'
        }
        return $pattern
    }

    # Appends one entry to the repo's sync-config.json (a full array round-trip).
    function Add-FixtureEntry {
        param($Entry)
        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $config.files = @($config.files) + $Entry
        [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
    }

    # Both engines must stop with the same path error before touching any file.
    function Assert-PathStop {
        param([string]$Message)
        $esc = [regex]::Escape($Message)

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $esc

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $esc

        @(Get-ChildItem -Path $script:HomeDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count | Should -Be 0

        $dotfiles = Join-Path $script:RepoDir 'dotfiles'
        if (Test-Path -LiteralPath $dotfiles) {
            @(Get-ChildItem -LiteralPath $dotfiles -Recurse -File -Force -ErrorAction SilentlyContinue).Count | Should -Be 0
        }
    }

    # -- Preview helpers --------------------------------------------------------

    function Copy-CiToRepo {
        $ciDir = Join-Path $script:RepoDir 'scripts\ci'
        $null = New-Item -ItemType Directory -Path $ciDir -Force
        Copy-Item -Path (Join-Path $Script:TestRepo 'scripts\ci\*') -Destination $ciDir -Recurse -Force
    }

    # Engine + fixtures + scripts/ci as a git repo with one commit (preview cases).
    function New-PreviewRepo {
        Copy-EngineToRepo
        Copy-CiToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles
        New-GitRepo
    }

    # The default local change for preview cases: modify dir/a/b.txt, add
    # dir/new.txt, delete dir/c.txt.
    function Set-PreviewChange {
        $a = Join-Path $script:HomeDir '.config\fixture\dir\a\b.txt'
        [IO.File]::WriteAllText($a, "b2`n", [System.Text.UTF8Encoding]::new($false))
        $new = Join-Path $script:HomeDir '.config\fixture\dir\new.txt'
        [IO.File]::WriteAllText($new, "new`n", [System.Text.UTF8Encoding]::new($false))
        Remove-Item -Path (Join-Path $script:HomeDir '.config\fixture\dir\c.txt') -Force
    }

    # Sorted path + SHA256 of every file under $Path, .git excluded. A stable
    # fingerprint used to assert a preview wrote nothing outside its temp dir.
    function Get-TreeHash {
        param([string]$Path)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $files = Get-ChildItem -Path $Path -File -Recurse -Force |
                Where-Object { $_.FullName -notlike "*\.git\*" }
            $lines = foreach ($f in $files) {
                $rel = ($f.FullName.Substring($Path.TrimEnd('\').Length + 1)) -replace '\\', '/'
                $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($f.FullName)))
                "$rel|$hash"
            }
            return (($lines | Sort-Object) -join "`n")
        } finally {
            $sha.Dispose()
        }
    }

    # -- sync.cmd helpers -------------------------------------------------------

    # The sync wrappers are not part of the engine copy; the sync cases add both
    # of them, so PowerShell has to choose sync.cmd over the extensionless sync.
    function Copy-SyncWrappers {
        Copy-Item -Path (Join-Path $Script:TestRepo 'sync') -Destination $script:RepoDir -Force
        Copy-Item -Path (Join-Path $Script:TestRepo 'sync.cmd') -Destination $script:RepoDir -Force
    }

    # Runs sync.cmd through cmd /c. Each argument is a separate element, so one
    # holding a space reaches the batch file quoted, as a real user would type it.
    # -Root picks another checkout (the clone); -InputText pipes stdin to it.
    function Invoke-SyncCmd {
        param([string[]]$CmdArgs = @(), [string]$Root = '', [string]$InputText = $null)
        # git in the front door writes progress to stderr, which must not fail the test.
        $ErrorActionPreference = 'Continue'
        if ($Root) {
            $script:EngineScript = Join-Path $Root 'sync.cmd'
        } else {
            $script:EngineScript = Join-Path $script:RepoDir 'sync.cmd'
        }
        # The front-door cases run sync.cmd in the temp repo; copy it in when a case didn't.
        if (-not (Test-Path -LiteralPath $script:EngineScript)) { Copy-SyncWrappers }
        if ($null -ne $InputText) {
            $script:EngineOut = $InputText | & cmd.exe /c $script:EngineScript @CmdArgs 2>&1 | Out-String
        } else {
            $script:EngineOut = & cmd.exe /c $script:EngineScript @CmdArgs 2>&1 | Out-String
        }
        $script:EngineExit = $LASTEXITCODE
    }

    # Runs `sync.cmd status` with a fixed OS name, restoring the variable after.
    function Invoke-SyncStatus {
        param([string]$OsName = 'Test OS')
        $saved = $env:SYNC_OS_NAME
        $env:SYNC_OS_NAME = $OsName
        try {
            Invoke-SyncCmd -CmdArgs @('status')
        } finally {
            if ($null -eq $saved) {
                Remove-Item Env:\SYNC_OS_NAME -ErrorAction SilentlyContinue
            } else {
                $env:SYNC_OS_NAME = $saved
            }
        }
    }

    # Runs Export-Settings.ps1 -Preview in the temp repo.
    function Invoke-Preview {
        param([switch]$ResetValues)
        $script:EngineScript = Join-Path $script:RepoDir 'scripts\windows\Export-Settings.ps1'
        if ($ResetValues) {
            $script:EngineOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript -Preview -ResetValues 2>&1 | Out-String
        } else {
            $script:EngineOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript -Preview 2>&1 | Out-String
        }
        $script:EngineExit = $LASTEXITCODE
    }

    # -- Commit helpers ----------------------------------------------------------

    # A stub gh.cmd that logs each invocation to $script:GhLog and prints a fixed
    # URL, placed first on PATH so Commit-Settings.ps1 finds it instead of gh.
    # -SignedOut makes `gh auth status` exit 1, for the doctor case.
    function New-GhStub {
        param([switch]$SignedOut)
        $script:BinDir = Join-Path $script:T 'bin'
        $null = New-Item -ItemType Directory -Path $script:BinDir -Force
        $script:GhLog = Join-Path $script:T 'gh.log'
        $stub = Join-Path $script:BinDir 'gh.cmd'
        $body = "@echo off`r`necho %*>> `"%GH_LOG%`"`r`n"
        if ($SignedOut) {
            $body += "if /i `"%1`"==`"auth`" exit /b 1`r`n"
        }
        $body += "echo https://github.com/example/pr/1`r`n"
        [IO.File]::WriteAllText($stub, $body, [Text.Encoding]::ASCII)
        $env:GH_LOG = $script:GhLog
        $env:PATH = "$script:BinDir;$env:PATH"
    }

    # Engine + fixtures + scripts/ci committed on master and pushed to a bare
    # origin, plus a fresh clone where Commit-Settings.ps1 actually runs.
    # -WithWrappers also commits sync and sync.cmd, as the real repo has them,
    # so the clone can run sync.cmd with a clean tree.
    function New-CommitRepo {
        param([switch]$WithWrappers)
        Copy-EngineToRepo
        Copy-CiToRepo
        Copy-RepoDotfiles
        if ($WithWrappers) {
            Copy-SyncWrappers
        }
        New-GitRepo
        $ErrorActionPreference = 'Continue'
        $script:CloneDir = Join-Path $script:T 'clone'
        git clone -q (Join-Path $script:T 'origin.git') $script:CloneDir 2>$null
        git -C $script:CloneDir config syncsettings.machine testbox 2>$null
        git -C $script:CloneDir config user.name t 2>$null
        git -C $script:CloneDir config user.email t@example.com 2>$null
        New-GhStub
    }

    # Runs Commit-Settings.ps1 in the clone with the stub gh on PATH.
    function Invoke-Commit {
        # git fetch and push write to stderr, which must not fail the test.
        $ErrorActionPreference = 'Continue'
        $script:EngineScript = Join-Path $script:CloneDir 'scripts\windows\Commit-Settings.ps1'
        $script:EngineOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:EngineScript 2>&1 | Out-String
        $script:EngineExit = $LASTEXITCODE
    }

    # A commit repo with the fixture values cached, ignored the way the real repo ignores them.
    function New-CommitValuesRepo {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'
        # Copy-EngineToRepo commits the values file, which the real repo never does.
        git -C $script:CloneDir rm -q --cached .user-values.json 2>$null
        git -C $script:CloneDir commit -qm 'stop tracking the values' 2>$null
        git -C $script:CloneDir push -q origin master 2>$null
        Add-Content -LiteralPath (Join-Path $script:CloneDir '.git\info\exclude') -Value '.user-values.json'
        Copy-Item -LiteralPath (Join-Path $Script:Fixtures 'user-values.json') -Destination (Join-Path $script:CloneDir '.user-values.json') -Force
    }

    function Set-CloneWinConf {
        param([string]$Text)
        $winConf = Join-Path $script:CloneDir 'dotfiles\windows\win.conf'
        [IO.File]::WriteAllText($winConf, $Text, [System.Text.UTF8Encoding]::new($false))
    }

    function Assert-CommitBlocked {
        param([string]$Placeholder)
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape("ERROR: a cached value for $Placeholder is in dotfiles/windows/win.conf; nothing was committed."))
        Get-OriginBranches | Should -Be 'refs/heads/master'
        (git -C $script:CloneDir branch --list 'sync/*' 2>$null | Out-String).Trim() | Should -Be ''
        $script:GhLog | Should -Not -Exist
    }

    # Refnames of every branch on the bare origin.
    function Get-OriginBranches {
        $ErrorActionPreference = 'Continue'
        $origin = Join-Path $script:T 'origin.git'
        (git --git-dir=$origin for-each-ref --format='%(refname)' refs/heads 2>$null | Out-String).Trim()
    }
}

Describe 'Windows engine' {
    BeforeEach {
        $script:T = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $script:T
        $script:HomeDir = Join-Path $script:T 'home'
        $null = New-Item -ItemType Directory -Path (Join-Path $script:HomeDir '.config\fixture') -Force
        $script:SavedUserProfile = $env:USERPROFILE
        $env:USERPROFILE = $script:HomeDir
        $script:SavedTemp = $env:TEMP
        $script:SavedTmp = $env:TMP
        $script:SavedPath = $env:PATH
        $script:SavedGhLog = $env:GH_LOG
    }

    AfterEach {
        $env:USERPROFILE = $script:SavedUserProfile
        if ($null -eq $script:SavedTemp) {
            Remove-Item Env:\TEMP -ErrorAction SilentlyContinue
        } else {
            $env:TEMP = $script:SavedTemp
        }
        if ($null -eq $script:SavedTmp) {
            Remove-Item Env:\TMP -ErrorAction SilentlyContinue
        } else {
            $env:TMP = $script:SavedTmp
        }
        $env:PATH = $script:SavedPath
        if ($null -eq $script:SavedGhLog) {
            Remove-Item Env:\GH_LOG -ErrorAction SilentlyContinue
        } else {
            $env:GH_LOG = $script:SavedGhLog
        }
        if (Test-Path $script:T) {
            Remove-Item $script:T -Recurse -Force
        }
    }

    It 'import-creates' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        $winConf | Should -Exist
        $want = Join-Path $Script:Fixtures 'home\.config\fixture\win.conf'
        ([IO.File]::ReadAllBytes($winConf) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')

        foreach ($name in @('plain.txt', 'tool.sh', 'named.conf', 'no-trailing.txt')) {
            (Join-Path $script:HomeDir ".config\fixture\$name") | Should -Not -Exist
        }
    }

    It 'export-adds' {
        Copy-EngineToRepo
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $winConf = Join-Path $script:RepoDir 'dotfiles\windows\win.conf'
        $winConf | Should -Exist
        $want = Join-Path $Script:Fixtures 'repo\dotfiles\windows\win.conf'
        ([IO.File]::ReadAllBytes($winConf) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')

        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/windows/win.conf' 'sanitized')
        (Join-Path $script:RepoDir 'dotfiles\linux') | Should -Not -Exist
    }

    It 'roundtrip-unchanged' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $exportExit = $script:EngineExit
        $exportOut = $script:EngineOut

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $importExit = $script:EngineExit
        $importOut = $script:EngineOut

        $exportExit | Should -Be 0
        $importExit | Should -Be 0

        $exportOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/windows/win.conf')
        $importOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/windows/win.conf')

        $exportOut | Should -Not -Match '\[(ADDED|MODIFIED)\s*\]'
        $importOut | Should -Not -Match '\[(CREATED|UPDATED)\s*\]'

        $baks = @(Get-ChildItem -Path $script:HomeDir -Recurse -Filter '*.bak' -File)
        $baks.Count | Should -Be 0
    }

    It 'import-backup' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($winConf, "old`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATED' 'dotfiles/windows/win.conf' 'backup saved as win.conf.bak')

        $want = Join-Path $Script:Fixtures 'home\.config\fixture\win.conf'
        ([IO.File]::ReadAllBytes($winConf) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')

        $bak = "$winConf.bak"
        $bak | Should -Exist
        ([IO.File]::ReadAllBytes($bak) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("old`r`n") -join ',')
    }

    It 'excluded' {
        Copy-EngineToRepo

        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $entry = [pscustomobject]@{
            repoPath    = 'dotfiles/windows/x.secret'
            localPath   = '~\.config\fixture\x.secret'
            platform    = 'windows'
            description = 'excluded fixture'
        }
        $config.files = @($config.files) + $entry
        $json = $config | ConvertTo-Json -Depth 10
        [IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))

        $secretPath = Join-Path $script:HomeDir '.config\fixture\x.secret'
        [IO.File]::WriteAllText($secretPath, "secret`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/windows/x.secret' 'matches exclude pattern')
        (Join-Path $script:RepoDir 'dotfiles\windows\x.secret') | Should -Not -Exist
    }

    It 'common-import' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $sharedConf = Join-Path $script:HomeDir '.config\fixture\shared.conf'
        $sharedConf | Should -Exist
        $want = Join-Path $Script:Fixtures 'home\.config\fixture\shared.conf'
        ([IO.File]::ReadAllBytes($sharedConf) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        $script:EngineOut | Should -Match (Get-StatusPattern 'CREATED' 'dotfiles/common/shared.conf')
    }

    It 'common-export' {
        Copy-EngineToRepo
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $sharedConf = Join-Path $script:RepoDir 'dotfiles\common\shared.conf'
        $sharedConf | Should -Exist
        $want = Join-Path $Script:Fixtures 'repo\dotfiles\common\shared.conf'
        ([IO.File]::ReadAllBytes($sharedConf) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/common/shared.conf' 'sanitized')
    }

    It 'missing-platform' {
        Copy-EngineToRepo

        # A linux entry on purpose: the check covers every entry, not only this engine's.
        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $entry = $config.files | Where-Object { $_.repoPath -eq 'dotfiles/linux/plain.txt' }
        $entry.PSObject.Properties.Remove('platform')
        $json = $config | ConvertTo-Json -Depth 10
        [IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))

        $msg = [regex]::Escape('ERROR: sync-config.json: entry dotfiles/linux/plain.txt needs "platform": "common", "windows", "linux", "macos" or a list of the last three.')

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $msg

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $msg

        @(Get-ChildItem -Path $script:HomeDir -Recurse -File).Count | Should -Be 0
        (Join-Path $script:RepoDir 'dotfiles') | Should -Not -Exist
    }

    It 'platform-macos-skipped' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/macos/m.txt'
            localPath   = '~/.config/fixture/m.txt'
            platform    = 'macos'
            description = 'macOS only fixture'
        })

        $localFile = Join-Path $script:HomeDir '.config\fixture\m.txt'
        [IO.File]::WriteAllText($localFile, "m`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        (Join-Path $script:RepoDir 'dotfiles\macos\m.txt') | Should -Not -Exist
        $script:EngineOut | Should -Not -Match ([regex]::Escape('dotfiles/macos/m.txt'))
    }

    It 'platform-list-linux-macos-skipped' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/common/m.txt'
            localPath   = '~/.config/fixture/m.txt'
            platform    = @('linux', 'macos')
            description = 'shared by the bash engines'
        })

        $localFile = Join-Path $script:HomeDir '.config\fixture\m.txt'
        [IO.File]::WriteAllText($localFile, "m`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        (Join-Path $script:RepoDir 'dotfiles\common\m.txt') | Should -Not -Exist
        $script:EngineOut | Should -Not -Match ([regex]::Escape('dotfiles/common/m.txt'))
    }

    It 'platform-list-with-windows-used' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/common/m.txt'
            localPath   = '~/.config/fixture/m.txt'
            platform    = @('windows', 'macos')
            description = 'shared with macOS'
        })

        $localFile = Join-Path $script:HomeDir '.config\fixture\m.txt'
        [IO.File]::WriteAllText($localFile, "m`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $repoFile = Join-Path $script:RepoDir 'dotfiles\common\m.txt'
        $repoFile | Should -Exist
        ([IO.File]::ReadAllBytes($repoFile) -join ',') | Should -Be ([IO.File]::ReadAllBytes($localFile) -join ',')
    }

    It 'platform-list-empty' {
        Copy-EngineToRepo

        # ConvertTo-Json does not reliably write [] for an empty array, so the
        # entry goes in as text with a real empty list.
        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $config.files = @($config.files) + [pscustomobject]@{
            repoPath    = 'dotfiles/common/empty.txt'
            localPath   = '~/.config/fixture/empty.txt'
            platform    = '__empty_platform_list__'
            description = 'empty platform list'
        }
        $json = $config | ConvertTo-Json -Depth 10
        $json = $json -replace '"platform":\s*"__empty_platform_list__"', '"platform": []'
        [IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
        (Get-Content $configPath -Raw) | Should -Match '"platform": \[\]'

        $msg = [regex]::Escape('ERROR: sync-config.json: entry dotfiles/common/empty.txt needs "platform": "common", "windows", "linux", "macos" or a list of the last three.')

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $msg

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $msg

        @(Get-ChildItem -Path $script:HomeDir -Recurse -File).Count | Should -Be 0
        (Join-Path $script:RepoDir 'dotfiles') | Should -Not -Exist
    }

    It 'localpaths-bad-key' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/common/m.txt'
            localPath   = '~/.config/fixture/m.txt'
            localPaths  = @{ bsd = '~/x' }
            platform    = 'common'
            description = 'unknown localPaths key'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/common/m.txt has an unknown localPaths key bsd.'
    }

    It 'localpaths-windows-used' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/common/m.txt'
            localPath   = '~/.config/fixture/m.txt'
            localPaths  = @{ windows = '~\other\m.txt' }
            platform    = 'common'
            description = 'per-system local path'
        })

        $repoFile = Join-Path $script:RepoDir 'dotfiles\common\m.txt'
        $null = New-Item -ItemType Directory -Path (Split-Path $repoFile -Parent) -Force
        [IO.File]::WriteAllText($repoFile, "m`r`n", [System.Text.UTF8Encoding]::new($false))
        # Import skips a file whose target folder is missing, so create it.
        $null = New-Item -ItemType Directory -Path (Join-Path $script:HomeDir 'other') -Force

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $target = Join-Path $script:HomeDir 'other\m.txt'
        $target | Should -Exist
        ([IO.File]::ReadAllBytes($target) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("m`r`n") -join ',')
        (Join-Path $script:HomeDir '.config\fixture\m.txt') | Should -Not -Exist
    }

    It 'localpaths-unsafe' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/common/m.txt'
            localPath   = '~/.config/fixture/m.txt'
            localPaths  = @{ windows = '~\..\x' }
            platform    = 'common'
            description = 'unsafe per-system path'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/common/m.txt has an unsafe path.'
    }

    It 'path-repo-traversal' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/../evil.txt'
            localPath   = '~\evil.txt'
            platform    = 'windows'
            description = 'unsafe repoPath'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/../evil.txt has an unsafe path.'
    }

    It 'path-repo-outside' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'outside/evil.txt'
            localPath   = '~\evil.txt'
            platform    = 'windows'
            description = 'unsafe repoPath'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry outside/evil.txt has an unsafe path.'
    }

    It 'path-local-traversal' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/windows/evil.txt'
            localPath   = '~\..\evil.txt'
            platform    = 'windows'
            description = 'unsafe localPath'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/windows/evil.txt has an unsafe path.'
    }

    It 'path-local-absolute' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/windows/evil.txt'
            localPath   = '/etc/passwd'
            platform    = 'windows'
            description = 'unsafe localPath'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/windows/evil.txt has an unsafe path.'
    }

    It 'path-repo-symlink' {
        Copy-EngineToRepo

        # A junction needs no admin rights, unlike a symlink, and it is a
        # reparse point either way. Its target exists so a recursive listing
        # cannot fail while following it.
        $target   = Join-Path $script:T 'junction-target'
        $junction = Join-Path $script:RepoDir 'dotfiles\linux\plain.txt'
        $null = New-Item -ItemType Directory -Path $target -Force
        $null = New-Item -ItemType Directory -Path (Split-Path $junction -Parent) -Force
        New-Item -ItemType Junction -Path $junction -Value $target | Out-Null

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/plain.txt has an unsafe path.'
    }

    It 'path-real-config' {
        Copy-EngineToRepo
        Copy-Item -Path (Join-Path $Script:TestRepo 'sync-config.json') -Destination (Join-Path $script:RepoDir 'sync-config.json') -Force

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match ([regex]::Escape('has an unsafe path'))

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match ([regex]::Escape('has an unsafe path'))
    }

    It 'path-dotted-name' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath    = 'dotfiles/windows/foo..bar.txt'
            localPath   = '~\.config\fixture\foo..bar.txt'
            platform    = 'windows'
            description = 'dotted name'
        })

        $localFile = Join-Path $script:HomeDir '.config\fixture\foo..bar.txt'
        [IO.File]::WriteAllText($localFile, "dotted`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/windows/foo..bar.txt')

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/windows/foo..bar.txt')
    }

    It 'dconf-entry-ignored' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            path     = '/test/app/'
            type     = 'dconf'
            platform = 'linux'
        })

        $repoFile = Join-Path $script:RepoDir 'dotfiles\linux\dconf\app.ini'
        $null = New-Item -ItemType Directory -Path (Split-Path $repoFile -Parent) -Force
        [IO.File]::WriteAllText($repoFile, "[/]`nkey=1`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match ([regex]::Escape('app.ini'))
        $script:EngineOut | Should -Not -Match 'ORPHAN'

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match ([regex]::Escape('app.ini'))
    }

    It 'dconf-path-missing' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            type     = 'dconf'
            platform = 'linux'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs "platform": "linux" and a dconf path like /org/gnome/shell/.'
    }

    It 'dconf-path-no-slash' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            path     = '/org/gnome'
            type     = 'dconf'
            platform = 'linux'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs "platform": "linux" and a dconf path like /org/gnome/shell/.'
    }

    It 'dconf-path-root' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            path     = '/'
            type     = 'dconf'
            platform = 'linux'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs "platform": "linux" and a dconf path like /org/gnome/shell/.'
    }

    It 'dconf-path-dotdot' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            path     = '/org/../etc/'
            type     = 'dconf'
            platform = 'linux'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs "platform": "linux" and a dconf path like /org/gnome/shell/.'
    }

    It 'dconf-platform-common' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            path     = '/test/app/'
            type     = 'dconf'
            platform = 'common'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs "platform": "linux" and a dconf path like /org/gnome/shell/.'
    }

    It 'dconf-platform-list' {
        Copy-EngineToRepo

        # ConvertTo-Json does not reliably write a one-item array as a list, so
        # the entry goes in as text with a real one-item list.
        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $config.files = @($config.files) + [pscustomobject]@{
            repoPath = 'dotfiles/linux/dconf/app.ini'
            path     = '/test/app/'
            type     = 'dconf'
            platform = '__platform_list__'
        }
        $json = $config | ConvertTo-Json -Depth 10
        $json = $json -replace '"platform":\s*"__platform_list__"', '"platform": ["linux"]'
        [IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
        (Get-Content $configPath -Raw) | Should -Match '"platform": \["linux"\]'

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs "platform": "linux" and a dconf path like /org/gnome/shell/.'
    }

    It 'dconf-repo-unsafe' {
        Copy-EngineToRepo
        Add-FixtureEntry ([pscustomobject]@{
            repoPath = 'dotfiles/../app.ini'
            path     = '/test/app/'
            type     = 'dconf'
            platform = 'linux'
        })

        Assert-PathStop 'ERROR: sync-config.json: entry dotfiles/../app.ini has an unsafe path.'
    }

    It 'escape-import' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $pathsIni = Join-Path $script:HomeDir '.config\fixture\paths.ini'
        $pathsIni | Should -Exist
        $want = Join-Path $Script:Fixtures 'home\.config\fixture\paths.ini'
        ([IO.File]::ReadAllBytes($pathsIni) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        $script:EngineOut | Should -Match (Get-StatusPattern 'CREATED' 'dotfiles/common/paths.ini')
    }

    It 'escape-export' {
        Copy-EngineToRepo
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $pathsIni = Join-Path $script:RepoDir 'dotfiles\common\paths.ini'
        $pathsIni | Should -Exist
        $want = Join-Path $Script:Fixtures 'repo\dotfiles\common\paths.ini'
        ([IO.File]::ReadAllBytes($pathsIni) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/common/paths.ini' 'sanitized')
    }

    It 'escape-roundtrip-unchanged' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $exportExit = $script:EngineExit
        $exportOut = $script:EngineOut

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $importExit = $script:EngineExit
        $importOut = $script:EngineOut

        $exportExit | Should -Be 0
        $importExit | Should -Be 0
        $exportOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/paths.ini')
        $importOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/paths.ini')

        $baks = @(Get-ChildItem -Path $script:HomeDir -Recurse -Filter '*.bak' -File)
        $baks.Count | Should -Be 0
    }

    It 'sanitize-longest-first' {
        Copy-EngineToRepo
        Copy-HomeFiles

        # <TOOLS> = C:\Tools is shorter than <WINPATH> = C:\Tools\gh.exe, so it must not
        # be replaced inside the longer value.
        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $entry = $config.files | Where-Object { $_.repoPath -eq 'dotfiles/common/paths.ini' }
        $rule = [pscustomobject]@{ placeholder = '<TOOLS>'; prompt = 'Tools dir' }
        $entry.sanitizeRules = @($entry.sanitizeRules) + $rule
        [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

        $valuesPath = Join-Path $script:RepoDir '.user-values.json'
        $values = Get-Content $valuesPath -Raw | ConvertFrom-Json
        $values | Add-Member -NotePropertyName '<TOOLS>' -NotePropertyValue 'C:\Tools' -Force
        [IO.File]::WriteAllText($valuesPath, ($values | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $pathsIni = Join-Path $script:RepoDir 'dotfiles\common\paths.ini'
        $want = Join-Path $Script:Fixtures 'repo\dotfiles\common\paths.ini'
        ([IO.File]::ReadAllBytes($pathsIni) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
    }

    It 'sanitized-case-change' {
        Copy-EngineToRepo

        # The lines differ only by case, and the sanitized form of the local file
        # is itself, so only a case-sensitive compare sees a change.
        $repoFile = Join-Path $script:RepoDir 'dotfiles\windows\win.conf'
        $null = New-Item -ItemType Directory -Path (Split-Path $repoFile -Parent) -Force
        [IO.File]::WriteAllText($repoFile, "editor = vim`n", [System.Text.UTF8Encoding]::new($false))
        $localFile = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($localFile, "EDITOR = VIM`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'MODIFIED' 'dotfiles/windows/win.conf' 'sanitized')
        $want = [System.Text.UTF8Encoding]::new($false).GetBytes("EDITOR = VIM`n")
        ([IO.File]::ReadAllBytes($repoFile) -join ',') | Should -Be ($want -join ',')
    }

    It 'dir-export-adds' {
        Copy-EngineToRepo
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        foreach ($rel in @('a\b.txt', 'c.txt')) {
            $repoFile = Join-Path $script:RepoDir "dotfiles\common\dir\$rel"
            $repoFile | Should -Exist
            $want = Join-Path $Script:Fixtures "repo\dotfiles\common\dir\$rel"
            ([IO.File]::ReadAllBytes($repoFile) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        }
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/common/dir/a/b.txt')
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/common/dir/c.txt')
    }

    It 'dir-bracket-name' {
        Copy-EngineToRepo
        Copy-HomeFiles

        $localFile = Join-Path $script:HomeDir '.config\fixture\dir\[x].txt'
        [IO.File]::WriteAllText($localFile, "b`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $repoFile = Join-Path $script:RepoDir 'dotfiles\common\dir\[x].txt'
        (Test-Path -LiteralPath $repoFile) | Should -BeTrue
        ([IO.File]::ReadAllBytes($repoFile) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("b`n") -join ',')
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/common/dir/[x].txt')

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $exportExit = $script:EngineExit
        $exportOut = $script:EngineOut

        $exportExit | Should -Be 0
        $exportOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/[x].txt')
        $exportOut | Should -Not -Match '\[REMOVED'

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $importExit = $script:EngineExit
        $importOut = $script:EngineOut

        $importExit | Should -Be 0
        $importOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/[x].txt')
        $importOut | Should -Not -Match '\[EXTRA'
    }

    It 'dir-export-modify-remove' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        $oldDir = Join-Path $script:RepoDir 'dotfiles\common\dir\old'
        $null = New-Item -ItemType Directory -Path $oldDir -Force
        [IO.File]::WriteAllText((Join-Path $oldDir 'old.txt'), "old`n", [System.Text.UTF8Encoding]::new($false))

        Copy-HomeFiles
        $localC = Join-Path $script:HomeDir '.config\fixture\dir\c.txt'
        [IO.File]::WriteAllText($localC, "c2`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'MODIFIED' 'dotfiles/common/dir/c.txt')
        $script:EngineOut | Should -Match (Get-StatusPattern 'REMOVED' 'dotfiles/common/dir/old/old.txt' 'no longer in source')
        $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/a/b.txt')

        $repoC = Join-Path $script:RepoDir 'dotfiles\common\dir\c.txt'
        ([IO.File]::ReadAllBytes($repoC) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("c2`n") -join ',')
        (Join-Path $script:RepoDir 'dotfiles\common\dir\old') | Should -Not -Exist
    }

    It 'dir-export-excluded' {
        Copy-EngineToRepo
        Copy-HomeFiles

        $bak = Join-Path $script:HomeDir '.config\fixture\dir\x.bak'
        [IO.File]::WriteAllText($bak, "x`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/common/dir/x.bak' 'matches exclude pattern')
        (Join-Path $script:RepoDir 'dotfiles\common\dir\x.bak') | Should -Not -Exist
    }

    It 'dir-export-missing' {
        Copy-EngineToRepo
        Copy-HomeFiles

        $localDir = Join-Path $script:HomeDir '.config\fixture\dir'
        Remove-Item -Path $localDir -Recurse -Force

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/common/dir/' "local folder not found: $localDir")
    }

    It 'dir-export-empty-keeps-repo' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        $localDir = Join-Path $script:HomeDir '.config\fixture\dir'
        Get-ChildItem -LiteralPath $localDir -Force | Remove-Item -Recurse -Force

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/common/dir/' 'local folder is empty; repo files kept')
        $script:EngineOut | Should -Not -Match '\[REMOVED'
        foreach ($rel in @('a\b.txt', 'c.txt')) {
            $repoFile = Join-Path $script:RepoDir "dotfiles\common\dir\$rel"
            $want = Join-Path $Script:Fixtures "repo\dotfiles\common\dir\$rel"
            ([IO.File]::ReadAllBytes($repoFile) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        }
    }

    It 'dir-export-only-excluded' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        $localDir = Join-Path $script:HomeDir '.config\fixture\dir'
        Get-ChildItem -LiteralPath $localDir -Force | Remove-Item -Recurse -Force
        [IO.File]::WriteAllText((Join-Path $localDir 'x.secret'), "x`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/common/dir/x.secret' 'matches exclude pattern')
        $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/common/dir/' 'local folder is empty; repo files kept')
        $script:EngineOut | Should -Not -Match '\[REMOVED'
        foreach ($rel in @('a\b.txt', 'c.txt')) {
            $repoFile = Join-Path $script:RepoDir "dotfiles\common\dir\$rel"
            $want = Join-Path $Script:Fixtures "repo\dotfiles\common\dir\$rel"
            ([IO.File]::ReadAllBytes($repoFile) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        }
    }

    It 'dir-export-one-left' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Remove-Item -LiteralPath (Join-Path $script:HomeDir '.config\fixture\dir\a\b.txt') -Force

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'REMOVED' 'dotfiles/common/dir/a/b.txt' 'no longer in source')
        (Join-Path $script:RepoDir 'dotfiles\common\dir\a\b.txt') | Should -Not -Exist
        $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/c.txt')
        $repoC = Join-Path $script:RepoDir 'dotfiles\common\dir\c.txt'
        $wantC = Join-Path $Script:Fixtures 'repo\dotfiles\common\dir\c.txt'
        ([IO.File]::ReadAllBytes($repoC) -join ',') | Should -Be ([IO.File]::ReadAllBytes($wantC) -join ',')
    }

    It 'dir-export-empty-both' {
        Copy-EngineToRepo
        Copy-HomeFiles

        $localDir = Join-Path $script:HomeDir '.config\fixture\dir'
        Get-ChildItem -LiteralPath $localDir -Force | Remove-Item -Recurse -Force

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/common/dir/' 'local folder is empty; repo files kept')
        $script:EngineOut | Should -Not -Match '\[REMOVED'
    }

    It 'dir-import-creates' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        foreach ($rel in @('a\b.txt', 'c.txt')) {
            $localFile = Join-Path $script:HomeDir ".config\fixture\dir\$rel"
            $localFile | Should -Exist
            $want = Join-Path $Script:Fixtures "home\.config\fixture\dir\$rel"
            ([IO.File]::ReadAllBytes($localFile) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        }
        $script:EngineOut | Should -Match (Get-StatusPattern 'CREATED' 'dotfiles/common/dir/a/b.txt')
        $script:EngineOut | Should -Match (Get-StatusPattern 'CREATED' 'dotfiles/common/dir/c.txt')
    }

    It 'dir-import-update-backup' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        $localC = Join-Path $script:HomeDir '.config\fixture\dir\c.txt'
        [IO.File]::WriteAllText($localC, "c2`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATED' 'dotfiles/common/dir/c.txt' 'backup saved as c.txt.bak')
        $want = Join-Path $Script:Fixtures 'home\.config\fixture\dir\c.txt'
        ([IO.File]::ReadAllBytes($localC) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        $bak = "$localC.bak"
        $bak | Should -Exist
        ([IO.File]::ReadAllBytes($bak) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("c2`n") -join ',')
        $script:EngineOut | Should -Not -Match '\[EXTRA'
    }

    It 'dir-import-extra' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        $mine = Join-Path $script:HomeDir '.config\fixture\dir\mine.txt'
        [IO.File]::WriteAllText($mine, "mine`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'EXTRA' 'dotfiles/common/dir/mine.txt' 'not in repo; kept')
        ([IO.File]::ReadAllBytes($mine) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("mine`n") -join ',')
    }

    It 'dir-roundtrip-unchanged' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $exportExit = $script:EngineExit
        $exportOut = $script:EngineOut

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $importExit = $script:EngineExit
        $importOut = $script:EngineOut

        $exportExit | Should -Be 0
        $importExit | Should -Be 0

        $exportOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/a/b.txt')
        $exportOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/c.txt')
        $importOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/a/b.txt')
        $importOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/dir/c.txt')

        $exportOut | Should -Not -Match '\[(ADDED|MODIFIED|REMOVED|CREATED|UPDATED|EXTRA)\s*\] dotfiles/common/dir/'
        $importOut | Should -Not -Match '\[(ADDED|MODIFIED|REMOVED|CREATED|UPDATED|EXTRA)\s*\] dotfiles/common/dir/'

        $baks = @(Get-ChildItem -Path $script:HomeDir -Recurse -Filter '*.bak' -File)
        $baks.Count | Should -Be 0
    }

    It 'infer-escaped' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        $valuesPath = Join-Path $script:RepoDir '.user-values.json'
        [IO.File]::WriteAllText($valuesPath, '{"<NAME>": "Fixture User"}', [System.Text.UTF8Encoding]::new($false))
        Copy-Item -Path (Join-Path $Script:Fixtures 'home\.config\fixture\paths.ini') -Destination (Join-Path $script:HomeDir '.config\fixture\paths.ini') -Force

        # The local file holds the doubled form, so inference stores the un-doubled
        # value; hydrate doubles it back and the repo file matches the local one.
        Invoke-EnginePiped -ScriptName 'Import-Settings.ps1'

        $script:EngineExit | Should -Be 0
        (Get-Content $valuesPath -Raw | ConvertFrom-Json).'<WINPATH>' | Should -BeExactly 'C:\Tools\gh.exe'
        $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/common/paths.ini')
        $pathsIni = Join-Path $script:HomeDir '.config\fixture\paths.ini'
        $want = Join-Path $Script:Fixtures 'home\.config\fixture\paths.ini'
        ([IO.File]::ReadAllBytes($pathsIni) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
        $baks = @(Get-ChildItem -Path $script:HomeDir -Recurse -Filter '*.bak' -File)
        $baks.Count | Should -Be 0
    }

    It 'noninteractive-missing-value-import' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        [IO.File]::WriteAllText((Join-Path $script:RepoDir '.user-values.json'), '{}', [System.Text.UTF8Encoding]::new($false))

        Invoke-EnginePiped -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('missing value for <NAME>'))
        (Join-Path $script:HomeDir '.config\fixture\win.conf') | Should -Not -Exist
    }

    It 'noninteractive-missing-value-export' {
        Copy-EngineToRepo
        Copy-HomeFiles
        [IO.File]::WriteAllText((Join-Path $script:RepoDir '.user-values.json'), '{}', [System.Text.UTF8Encoding]::new($false))

        Invoke-EnginePiped -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('missing value for <NAME>'))
        (Join-Path $script:RepoDir 'dotfiles\windows\win.conf') | Should -Not -Exist
    }

    It 'noninteractive-default' {
        Copy-EngineToRepo
        Copy-RepoDotfiles

        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        foreach ($entry in $config.files) {
            if (-not $entry.PSObject.Properties['sanitizeRules']) { continue }
            foreach ($rule in $entry.sanitizeRules) {
                if ($rule.placeholder -eq '<NAME>') {
                    $rule | Add-Member -NotePropertyName default -NotePropertyValue 'Fixture User' -Force
                }
            }
        }
        $json = $config | ConvertTo-Json -Depth 10
        [IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $script:RepoDir '.user-values.json'), '{"<WINPATH>": "C:\\Tools\\gh.exe"}', [System.Text.UTF8Encoding]::new($false))

        Invoke-EnginePiped -ScriptName 'Import-Settings.ps1' -Force

        $script:EngineExit | Should -Be 0
        $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        $winConf | Should -Exist
        $want = Join-Path $Script:Fixtures 'home\.config\fixture\win.conf'
        ([IO.File]::ReadAllBytes($winConf) -join ',') | Should -Be ([IO.File]::ReadAllBytes($want) -join ',')
    }

    It 'orphan-reported' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        $stray = Join-Path $script:RepoDir 'dotfiles\linux\stray.txt'
        [IO.File]::WriteAllText($stray, "stray`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'ORPHAN' 'dotfiles/linux/stray.txt' 'no entry in sync-config.json; git rm it or add an entry')
        [regex]::Matches($script:EngineOut, '\[ORPHAN').Count | Should -Be 1
    }

    It 'orphan-none' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match '\[ORPHAN'
    }

    It 'orphan-linked-ok' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        $configPath = Join-Path $script:RepoDir 'sync-config.json'
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $linkedEntry = [pscustomobject]@{
            repoPath          = 'dotfiles/windows/linked.sh'
            localPath         = '~\linked.sh'
            platform          = 'windows'
            detectLinkedPaths = $true
        }
        $config.files = @($config.files) + $linkedEntry
        [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

        $winDir = Join-Path $script:RepoDir 'dotfiles\windows'
        [IO.File]::WriteAllText((Join-Path $winDir 'linked.sh'), "echo linked`n", [System.Text.UTF8Encoding]::new($false))
        $toolDir = Join-Path $winDir 'linked.sh.linked\tool'
        $null = New-Item -ItemType Directory -Path $toolDir -Force
        [IO.File]::WriteAllText((Join-Path $toolDir 'x.bat'), "echo x`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Engine -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match '\[ORPHAN'
    }

    It 'import-linked-keeps-local' {
        Copy-EngineToRepo

        # A linked folder lives on the system drive, outside the system paths
        # Find-LinkedPaths filters out (C:\Windows, C:\Program Files, C:\Users, ...).
        $linkedRoot = "$env:SystemDrive\SyncSettingsTest-$([guid]::NewGuid().ToString('N'))"
        $toolDir    = "$linkedRoot\tool"
        $null = New-Item -ItemType Directory -Path $toolDir -Force

        try {
            $configPath = Join-Path $script:RepoDir 'sync-config.json'
            $config = Get-Content $configPath -Raw | ConvertFrom-Json
            $linkedEntry = [pscustomobject]@{
                repoPath          = 'dotfiles/windows/linked.sh'
                localPath         = '~\linked.sh'
                platform          = 'windows'
                detectLinkedPaths = $true
            }
            $config.files = @($config.files) + $linkedEntry
            [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

            $winDir = Join-Path $script:RepoDir 'dotfiles\windows'
            $null = New-Item -ItemType Directory -Path $winDir -Force
            [IO.File]::WriteAllText((Join-Path $winDir 'linked.sh'), "script`n$toolDir`n", [System.Text.UTF8Encoding]::new($false))
            $linkRepo = Join-Path $winDir 'linked.sh.linked\tool'
            $null = New-Item -ItemType Directory -Path $linkRepo -Force
            [IO.File]::WriteAllText((Join-Path $linkRepo 'a.txt'), "repo-a`n", [System.Text.UTF8Encoding]::new($false))

            # Local: a differing file, a local-only file, and an excluded file.
            [IO.File]::WriteAllText((Join-Path $toolDir 'a.txt'), "local-a`n", [System.Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText((Join-Path $toolDir 'local.txt'), "mine`n", [System.Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText((Join-Path $toolDir 'x.bak'), "x`n", [System.Text.UTF8Encoding]::new($false))

            Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATED' 'dotfiles/windows/linked.sh.linked/tool/a.txt' 'backup saved as a.txt.bak')
            $script:EngineOut | Should -Match (Get-StatusPattern 'EXTRA' 'dotfiles/windows/linked.sh.linked/tool/local.txt' 'not in repo; kept')
            $script:EngineOut | Should -Not -Match 'x\.bak'

            $aTxt = Join-Path $toolDir 'a.txt'
            ([IO.File]::ReadAllBytes($aTxt) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("repo-a`n") -join ',')
            "$aTxt.bak" | Should -Exist
            ([IO.File]::ReadAllBytes("$aTxt.bak") -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("local-a`n") -join ',')
            ([IO.File]::ReadAllBytes((Join-Path $toolDir 'local.txt')) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("mine`n") -join ',')
            ([IO.File]::ReadAllBytes((Join-Path $toolDir 'x.bak')) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("x`n") -join ',')
        } finally {
            if (Test-Path -LiteralPath $linkedRoot) {
                Remove-Item -LiteralPath $linkedRoot -Recurse -Force
            }
        }
    }

    It 'linked-export-empty-keeps-repo' {
        Copy-EngineToRepo

        # A linked folder lives on the system drive, outside the system paths
        # Find-LinkedPaths filters out (C:\Windows, C:\Program Files, C:\Users, ...).
        $linkedRoot = "$env:SystemDrive\SyncSettingsTest-$([guid]::NewGuid().ToString('N'))"
        $toolDir    = "$linkedRoot\tool"
        $null = New-Item -ItemType Directory -Path $toolDir -Force

        try {
            $configPath = Join-Path $script:RepoDir 'sync-config.json'
            $config = Get-Content $configPath -Raw | ConvertFrom-Json
            $linkedEntry = [pscustomobject]@{
                repoPath          = 'dotfiles/windows/linked.sh'
                localPath         = '~\linked.sh'
                platform          = 'windows'
                detectLinkedPaths = $true
            }
            $config.files = @($config.files) + $linkedEntry
            [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

            $winDir = Join-Path $script:RepoDir 'dotfiles\windows'
            $null = New-Item -ItemType Directory -Path $winDir -Force
            [IO.File]::WriteAllText((Join-Path $winDir 'linked.sh'), "script`n$toolDir`n", [System.Text.UTF8Encoding]::new($false))
            $linkRepo = Join-Path $winDir 'linked.sh.linked\tool'
            $null = New-Item -ItemType Directory -Path $linkRepo -Force
            $repoA = Join-Path $linkRepo 'a.txt'
            [IO.File]::WriteAllText($repoA, "repo-a`n", [System.Text.UTF8Encoding]::new($false))

            # The entry file points at the folder, but the local folder is empty.
            [IO.File]::WriteAllText((Join-Path $script:HomeDir 'linked.sh'), "script`n$toolDir`n", [System.Text.UTF8Encoding]::new($false))

            Invoke-Engine -ScriptName 'Export-Settings.ps1'

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/windows/linked.sh.linked/tool/' 'local folder is empty; repo files kept')
            $script:EngineOut | Should -Not -Match '\[REMOVED'
            ([IO.File]::ReadAllBytes($repoA) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("repo-a`n") -join ',')
        } finally {
            if (Test-Path -LiteralPath $linkedRoot) {
                Remove-Item -LiteralPath $linkedRoot -Recurse -Force
            }
        }
    }

    It 'real-config-roundtrip' {
        Copy-EngineToRepo
        Copy-Item -Path (Join-Path $Script:TestRepo 'sync-config.json') -Destination (Join-Path $script:RepoDir 'sync-config.json') -Force
        Copy-Item -Path (Join-Path $Script:TestRepo 'dotfiles') -Destination $script:RepoDir -Recurse -Force

        # Fake values for the real config's placeholders; never reads the real
        # .user-values.json. <GH_CLI_PATH> is cached un-doubled, as on a real machine.
        $valuesPath = Join-Path $script:RepoDir '.user-values.json'
        [IO.File]::WriteAllText(
            $valuesPath,
            '{"<YOUR_NAME>":"Fixture User","<YOUR_EMAIL>":"fixture@example.com","<YOUR_GH_USERNAME>":"fixture-user","<YOUR_GH_ORG>":"fixture-org","<GH_CLI_PATH>":"C:\\Tools\\gh.exe"}',
            [System.Text.UTF8Encoding]::new($false))

        # Point .bashrc at a throwaway linked folder on the system drive, so this
        # test never touches the real C:\MakuCustomAlias (the suite also runs on
        # the real machine). The leaf name stays MakuCustomAlias, so the repo's
        # .bashrc.linked\MakuCustomAlias folder still matches.
        $guid       = [guid]::NewGuid().ToString('N')
        $linkedRoot = "$env:SystemDrive\SyncSettingsTest-$guid"
        $drive      = $env:SystemDrive[0].ToString().ToLowerInvariant()
        $bashrc     = Join-Path $script:RepoDir 'dotfiles\windows\shell\.bashrc'
        $content    = [IO.File]::ReadAllText($bashrc)
        $content    = $content.Replace('/c/MakuCustomAlias', "/$drive/SyncSettingsTest-$guid/MakuCustomAlias")
        [IO.File]::WriteAllText($bashrc, $content, [System.Text.UTF8Encoding]::new($false))

        # Git for Windows resolves the [include] path = ~/.gitconfig.local with
        # HOME, so the git config check below needs HOME to be the temp home.
        $savedHome = $env:HOME
        $env:HOME = $script:HomeDir

        try {
            # Import skips a missing target folder, so create the folders whose
            # parents don't exist in a fresh home.
            $null = New-Item -ItemType Directory -Path (Join-Path $script:HomeDir 'AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState') -Force
            $null = New-Item -ItemType Directory -Path (Join-Path $script:HomeDir '.claude\docs') -Force
            $null = New-Item -ItemType Directory -Path (Join-Path $script:HomeDir '.config\git') -Force

            Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
            $importExit = $script:EngineExit
            $importOut  = $script:EngineOut

            $importExit | Should -Be 0
            $importOut | Should -Not -Match '\[ERROR'
            # The real dotfiles include dotfiles/linux/gnome/dconf/**. Those
            # entries are platform linux, so the Windows engine must leave them
            # alone and never mention them.
            $importOut | Should -Not -Match 'dconf'

            foreach ($rel in @('.bashrc', '.bash_profile', '.gitconfig', '.gitconfig.local', '.claude\RTK.md', '.claude\docs\token-routing-map.html', '.config\git\ignore')) {
                (Join-Path $script:HomeDir $rel) | Should -Exist
            }
            (Join-Path $script:HomeDir 'AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json') | Should -Exist
            (Join-Path $linkedRoot 'MakuCustomAlias\vs.bat') | Should -Exist

            (Join-Path $script:HomeDir '.claude\CLAUDE.md') | Should -Not -Exist
            (Join-Path $script:HomeDir '.claude\hooks') | Should -Not -Exist
            (Join-Path $script:HomeDir '.claude-worker') | Should -Not -Exist
            (Join-Path $script:HomeDir '.tmux.conf') | Should -Not -Exist
            (Join-Path $script:HomeDir '.config\gh') | Should -Not -Exist
            (Join-Path $script:HomeDir '.config\rtk') | Should -Not -Exist

            Invoke-Engine -ScriptName 'Export-Settings.ps1'
            $exportExit = $script:EngineExit
            $exportOut  = $script:EngineOut

            $exportExit | Should -Be 0
            $exportOut | Should -Match ([regex]::Escape('Repo is up to date'))
            $exportOut | Should -Not -Match '\[(MODIFIED|ADDED|REMOVED|ORPHAN|ERROR)\s*\]'
            # The ORPHAN check above now covers dotfiles/linux/gnome/dconf/ too,
            # since those files are copied in with the real dotfiles.
            $exportOut | Should -Not -Match 'dconf'

            # The file holds doubled backslashes; git undoes them, so the last
            # helper is the single-backslash form. Proves ~/.gitconfig.local resolves.
            $ErrorActionPreference = 'Continue'
            $helpers = @(git config --file (Join-Path $script:HomeDir '.gitconfig') --includes --get-all credential.https://github.com.helper 2>$null)
            $helpers[-1] | Should -Be "!'C:\Tools\gh.exe' auth git-credential"

            # RTK.md and .config/git/ignore are dotfiles/common/** (eol=lf), so no
            # CR byte survives the runner's core.autocrlf=true checkout. Check
            # bytes, not text.
            $rtkBytes = [IO.File]::ReadAllBytes((Join-Path $script:HomeDir '.claude\RTK.md'))
            $rtkBytes | Should -Not -Contain 13
            $ignoreBytes = [IO.File]::ReadAllBytes((Join-Path $script:HomeDir '.config\git\ignore'))
            $ignoreBytes | Should -Not -Contain 13
        } finally {
            if ($null -eq $savedHome) {
                Remove-Item Env:\HOME -ErrorAction SilentlyContinue
            } else {
                $env:HOME = $savedHome
            }
            if (Test-Path -LiteralPath $linkedRoot) {
                Remove-Item -LiteralPath $linkedRoot -Recurse -Force
            }
        }
    }

    It 'upstream-none' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Invoke-EnginePiped -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match 'NOTE:|WARNING: repo is'
    }

    It 'upstream-current' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles
        New-GitRepo

        Invoke-EnginePiped -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Not -Match 'NOTE:|WARNING: repo is'
    }

    It 'upstream-behind-noninteractive' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles
        New-GitRepo

        $ErrorActionPreference = 'Continue'

        $other = Join-Path $script:T 'other'
        git clone -q (Join-Path $script:T 'origin.git') $other 2>$null
        [IO.File]::WriteAllText((Join-Path $other 'README'), "x`n", [System.Text.UTF8Encoding]::new($false))
        git -C $other add README 2>$null
        git -C $other -c user.name=t -c user.email=t@example.com commit -q -m ahead 2>$null
        git -C $other push -q origin master 2>$null

        $headBefore = (git -C $script:RepoDir rev-parse HEAD 2>$null | Out-String).Trim()

        Invoke-EnginePiped -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('WARNING: repo is 1 commit(s) behind origin/master; run git pull --ff-only.'))
        $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/windows/win.conf')
        $headAfter = (git -C $script:RepoDir rev-parse HEAD 2>$null | Out-String).Trim()
        $headAfter | Should -Be $headBefore
    }

    It 'upstream-unreachable' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles
        New-GitRepo

        $ErrorActionPreference = 'Continue'
        git -C $script:RepoDir remote set-url origin (Join-Path $script:T 'missing.git') 2>$null

        Invoke-EnginePiped -ScriptName 'Export-Settings.ps1'

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('NOTE: could not reach origin; skipping the up-to-date check.'))
        $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/windows/win.conf')
    }

    It 'preview-writes-nothing' {
        New-PreviewRepo
        Set-PreviewChange

        $repoBefore = Get-TreeHash $script:RepoDir
        $homeBefore = Get-TreeHash $script:HomeDir

        Invoke-Preview

        $script:EngineExit | Should -Be 0
        (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore

        $ErrorActionPreference = 'Continue'
        $status = (git -C $script:RepoDir status --short 2>$null | Out-String).Trim()
        $status | Should -Be ''

        $script:EngineOut | Should -Match (Get-StatusPattern 'MODIFIED' 'dotfiles/common/dir/a/b.txt')
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/common/dir/new.txt')
        $script:EngineOut | Should -Match (Get-StatusPattern 'REMOVED' 'dotfiles/common/dir/c.txt' 'no longer in source')
        $script:EngineOut | Should -Match ([regex]::Escape('Nothing was written.'))
    }

    It 'preview-shows-diff' {
        New-PreviewRepo
        Set-PreviewChange

        Invoke-Preview

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match '\+b2'
        $script:EngineOut | Should -Match ([regex]::Escape('before/dotfiles/common/dir/a/b.txt'))
    }

    It 'preview-matches-export' {
        New-PreviewRepo
        Set-PreviewChange

        Invoke-Preview
        $script:EngineExit | Should -Be 0

        $previewPaths = @($script:EngineOut -split "`r?`n" | ForEach-Object {
            if ($_ -match '^\s*\[(MODIFIED|ADDED|REMOVED)\s*\]\s+(\S+)') { $Matches[2] }
        } | Sort-Object -Unique)

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 0

        $ErrorActionPreference = 'Continue'
        $exportPaths = @(((git -C $script:RepoDir status --short -- dotfiles 2>$null | Out-String) -split "`r?`n") | ForEach-Object {
            if ($_ -match '^..\s+(.+)$') { $Matches[1] }
        } | Where-Object { $_ } | Sort-Object -Unique)

        ($previewPaths -join "`n") | Should -Be ($exportPaths -join "`n")
    }

    It 'preview-includes-uncommitted' {
        New-PreviewRepo
        Set-PreviewChange

        # Export for real but do not commit, so the change is only in the working tree.
        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 0

        Invoke-Preview

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match '\+b2'
    }

    It 'preview-no-changes' {
        New-PreviewRepo

        Invoke-Preview

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('Nothing would be sent'))
    }

    It 'preview-sanitized' {
        New-PreviewRepo

        $conf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($conf, "user = Fixture User`r`n# comment`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Preview

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match '<NAME>'
        $script:EngineOut | Should -Not -Match 'Fixture User'
    }

    It 'preview-leak-found' {
        New-PreviewRepo

        $conf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($conf, "user = C:\Users\someone\secret`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Preview

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('WARNING: the leak scan'))
        $script:EngineOut | Should -Not -Match ([regex]::Escape('C:\Users\someone'))
    }

    It 'preview-cleans-up' {
        New-PreviewRepo
        Set-PreviewChange

        $env:TEMP = Join-Path $script:T 'tmp'
        $env:TMP = Join-Path $script:T 'tmp'
        $null = New-Item -ItemType Directory -Path $env:TEMP -Force

        # Passing run.
        Invoke-Preview
        $script:EngineExit | Should -Be 0
        @(Get-ChildItem -Path $env:TEMP -Force).Count | Should -Be 0

        # Failing run: a leak makes the preview exit 1.
        $conf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($conf, "user = C:\Users\someone\secret`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Preview
        $script:EngineExit | Should -Be 1
        @(Get-ChildItem -Path $env:TEMP -Force).Count | Should -Be 0
    }

    It 'preview-reset-rejected' {
        New-PreviewRepo
        Set-PreviewChange

        $repoBefore = Get-TreeHash $script:RepoDir
        $homeBefore = Get-TreeHash $script:HomeDir

        Invoke-Preview -ResetValues

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: --preview cannot be combined with --reset-values.'))

        (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
    }

    It 'preview-not-a-repo' {
        Copy-EngineToRepo
        Copy-RepoDotfiles
        Copy-HomeFiles

        Invoke-Preview

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: --preview needs a git repo with a commit.'))
    }

    It 'preview-scan-missing' {
        New-PreviewRepo
        Set-PreviewChange

        Remove-Item -Path (Join-Path $script:RepoDir 'scripts\ci\leak-scan.sh') -Force

        Invoke-Preview

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: leak scan could not run; nothing was committed.'))
        $script:EngineOut | Should -Not -Match ([regex]::Escape('before/dotfiles'))
    }

    # -- Commit-Settings.ps1 -----------------------------------------------------

    It 'commit-happy' {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'

        $origin = Join-Path $script:T 'origin.git'
        $originMaster = (git --git-dir=$origin rev-parse master 2>$null | Out-String).Trim()

        $winConf = Join-Path $script:CloneDir 'dotfiles\windows\win.conf'
        [IO.File]::WriteAllText($winConf, "changed`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 0

        (git --git-dir=$origin rev-parse master 2>$null | Out-String).Trim() | Should -Be $originMaster
        (git -C $script:CloneDir symbolic-ref --short HEAD 2>$null | Out-String).Trim() | Should -Be 'master'

        $branches = (git --git-dir=$origin for-each-ref --format='%(refname)' refs/heads 2>$null | Out-String)
        @($branches -split "`r?`n" | Where-Object { $_ -match '^refs/heads/sync/windows-testbox-' }).Count | Should -Be 1

        @(Get-Content $script:GhLog).Count | Should -Be 1
    }

    It 'commit-leak-blocked' {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'

        # A home-style path the scan flags, built by concatenation so the literal
        # never appears in this file.
        $leaky = '/ho' + 'me/someone/x'
        $winConf = Join-Path $script:CloneDir 'dotfiles\windows\win.conf'
        [IO.File]::WriteAllText($winConf, "$leaky`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: the leak scan found the lines above; nothing was committed.'))

        Get-OriginBranches | Should -Be 'refs/heads/master'
        (git -C $script:CloneDir branch --list 'sync/*' 2>$null | Out-String).Trim() | Should -Be ''
        $script:GhLog | Should -Not -Exist
    }

    It 'commit-packages' {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'

        $origin = Join-Path $script:T 'origin.git'
        $originMaster = (git --git-dir=$origin rev-parse master 2>$null | Out-String).Trim()

        $aptList = Join-Path $script:CloneDir 'packages\linux\apt.txt'
        $null = New-Item -ItemType Directory -Path (Split-Path $aptList -Parent) -Force
        [IO.File]::WriteAllText($aptList, "foo`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 0

        (git --git-dir=$origin rev-parse master 2>$null | Out-String).Trim() | Should -Be $originMaster

        $branches = @((git --git-dir=$origin for-each-ref --format='%(refname)' refs/heads 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^refs/heads/sync/windows-testbox-' })
        $branches.Count | Should -Be 1
        $syncBranch = $branches[0] -replace '^refs/heads/', ''
        (git --git-dir=$origin show "${syncBranch}:packages/linux/apt.txt" 2>$null | Out-String).Trim() | Should -Be 'foo'
    }

    It 'commit-packages-leak-blocked' {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'

        # A home-style path the scan flags, built by concatenation so the literal
        # never appears in this file.
        $leaky = '/ho' + 'me/someone/x'
        $aptList = Join-Path $script:CloneDir 'packages\linux\apt.txt'
        $null = New-Item -ItemType Directory -Path (Split-Path $aptList -Parent) -Force
        [IO.File]::WriteAllText($aptList, "$leaky`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: the leak scan found the lines above; nothing was committed.'))
        $script:EngineOut | Should -Match ([regex]::Escape('packages/linux/apt.txt'))
        $script:EngineOut | Should -Match ([regex]::Escape('home-path'))
        $script:EngineOut | Should -Not -Match ([regex]::Escape($leaky))

        Get-OriginBranches | Should -Be 'refs/heads/master'
        (git -C $script:CloneDir branch --list 'sync/*' 2>$null | Out-String).Trim() | Should -Be ''
        $script:GhLog | Should -Not -Exist
    }

    It 'commit-scan-missing' {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'

        # Removed in a commit: an uncommitted removal stops at the outside-changes check.
        git -C $script:CloneDir rm -q scripts/ci/leak-scan.sh 2>$null
        git -C $script:CloneDir commit -qm 'remove the scan' 2>$null

        $winConf = Join-Path $script:CloneDir 'dotfiles\windows\win.conf'
        [IO.File]::WriteAllText($winConf, "changed`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: leak scan could not run; nothing was committed.'))

        Get-OriginBranches | Should -Be 'refs/heads/master'
        (git -C $script:CloneDir branch --list 'sync/*' 2>$null | Out-String).Trim() | Should -Be ''
        $script:GhLog | Should -Not -Exist
    }

    It 'commit-outside-changes' {
        New-CommitRepo
        $ErrorActionPreference = 'Continue'

        [IO.File]::WriteAllText((Join-Path $script:CloneDir 'outside.txt'), "outside`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: commit or stash changes outside dotfiles/ first.'))

        Get-OriginBranches | Should -Be 'refs/heads/master'
        (git -C $script:CloneDir branch --list 'sync/*' 2>$null | Out-String).Trim() | Should -Be ''
        $script:GhLog | Should -Not -Exist
    }

    It 'commit-value-blocked' {
        New-CommitValuesRepo
        Set-CloneWinConf "author = Fixture User`r`n"

        Invoke-Commit

        Assert-CommitBlocked '<NAME>'
    }

    It 'commit-value-case-variant' {
        New-CommitValuesRepo
        Set-CloneWinConf "author = FIXTURE user`r`n"

        Invoke-Commit

        Assert-CommitBlocked '<NAME>'
    }

    It 'commit-value-doubled' {
        New-CommitValuesRepo
        Set-CloneWinConf "tool = C:\\Tools\\gh.exe`r`n"

        Invoke-Commit

        Assert-CommitBlocked '<WINPATH>'
    }

    It 'commit-value-untracked' {
        New-CommitValuesRepo
        $newDir = Join-Path $script:CloneDir 'dotfiles\windows\new'
        $null = New-Item -ItemType Directory -Path $newDir -Force
        [IO.File]::WriteAllText((Join-Path $newDir 'added.txt'), "author = Fixture User`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-Commit

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('ERROR: a cached value for <NAME> is in dotfiles/windows/new/added.txt; nothing was committed.'))
    }

    It 'commit-value-placeholder-only' {
        New-CommitValuesRepo
        Set-CloneWinConf "author = <NAME>`r`n"

        Invoke-Commit

        $script:EngineExit | Should -Be 0
        @(Get-Content $script:GhLog).Count | Should -Be 1
    }

    It 'commit-value-not-printed' {
        New-CommitValuesRepo
        Set-CloneWinConf "author = Fixture User`r`n"

        Invoke-Commit

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Not -Match 'Fixture User'
    }

    # -- sync.cmd ---------------------------------------------------------------

    It 'sync-cmd-usage' {
        Copy-EngineToRepo
        Copy-SyncWrappers

        Invoke-SyncCmd -CmdArgs @('help')

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('usage: mksync [command] [options]'))
        $script:EngineOut | Should -Match ([regex]::Escape('Detected: windows'))
    }

    It 'sync-cmd-unknown' {
        Copy-EngineToRepo
        Copy-SyncWrappers

        Invoke-SyncCmd -CmdArgs @('bogus')

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape('Unknown command: bogus'))
    }

    It 'sync-cmd-export' {
        Copy-EngineToRepo
        Copy-SyncWrappers
        Copy-HomeFiles

        Invoke-SyncCmd -CmdArgs @('export')

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'ADDED' 'dotfiles/windows/win.conf' 'sanitized')
    }

    It 'sync-cmd-import-force' {
        Copy-EngineToRepo
        Copy-SyncWrappers
        Copy-RepoDotfiles

        $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($winConf, "old`r`n", [System.Text.UTF8Encoding]::new($false))

        # -Force must reach Import-Settings.ps1, or it would prompt before overwriting.
        Invoke-SyncCmd -CmdArgs @('import', '-Force')

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATED' 'dotfiles/windows/win.conf' 'backup saved as win.conf.bak')
    }

    It 'sync-cmd-preview' {
        New-PreviewRepo
        Copy-SyncWrappers
        Set-PreviewChange

        Invoke-SyncCmd -CmdArgs @('preview')

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match (Get-StatusPattern 'MODIFIED' 'dotfiles/common/dir/a/b.txt')
        $script:EngineOut | Should -Match ([regex]::Escape('Nothing was written.'))
        $script:EngineOut | Should -Match ([regex]::Escape("Run mksync push to send it."))
    }

    It 'sync-cmd-check' {
        Copy-EngineToRepo
        Copy-SyncWrappers
        Copy-RepoDotfiles

        $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
        [IO.File]::WriteAllText($winConf, "old`r`n", [System.Text.UTF8Encoding]::new($false))

        Invoke-SyncCmd -CmdArgs @('check') -InputText ""

        $syncExit = $script:EngineExit
        $syncOut = $script:EngineOut

        # check must route to Import-Settings.ps1 -Check with the same result.
        Invoke-ImportCheck

        $syncExit | Should -Be $script:EngineExit
        $syncExit | Should -BeIn @(0, 3)
        $syncOut | Should -Match ([regex]::Escape('IMPORT CHECK'))
    }

    It 'sync-cmd-help-lists-check' {
        Copy-EngineToRepo
        Copy-SyncWrappers

        Invoke-SyncCmd -CmdArgs @('help')

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('preview | check | export | commit | import'))
    }

    It 'sync-cmd-message-quotes' {
        Copy-EngineToRepo
        Copy-SyncWrappers

        # Commit-Settings -Message cannot run without a git repo and gh, so this
        # asks Import-Settings to resolve a quoted user name with a space and
        # checks the whole value came through as one argument, not two.
        Invoke-SyncCmd -CmdArgs @('import', '-User', 'Fixture User')

        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match ([regex]::Escape("Cannot resolve profile directory for user 'Fixture User'"))
    }

    It 'sync-powershell-resolves' {
        Copy-EngineToRepo
        Copy-SyncWrappers

        # PowerShell prefers sync.cmd from PATHEXT; the extensionless sync is not
        # executable there. The output proves which one ran.
        Push-Location $script:RepoDir
        try {
            $script:EngineOut = & .\sync help 2>&1 | Out-String
            $script:EngineExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('Detected: windows'))
    }

    # -- Import check -----------------------------------------------------------

    Context 'Import check' {
        It 'import check writes nothing' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            Copy-HomeFiles

            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            [IO.File]::WriteAllText($winConf, "old`r`n", [System.Text.UTF8Encoding]::new($false))
            Remove-Item -LiteralPath (Join-Path $script:HomeDir '.config\fixture\shared.conf') -Force

            $valuesPath = Join-Path $script:RepoDir '.user-values.json'
            $valuesBefore = ([IO.File]::ReadAllBytes($valuesPath) -join ',')
            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 3
            $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATE' 'dotfiles/windows/win.conf')
            $script:EngineOut | Should -Match (Get-StatusPattern 'CREATE' 'dotfiles/common/shared.conf')
            $script:EngineOut | Should -Match ([regex]::Escape('file(s) would change. mksync pull overwrites them (each keeps a .bak).'))
            $script:EngineOut | Should -Match ([regex]::Escape('If you changed them on this machine, run mksync push first.'))
            @(Get-ChildItem -Path $script:HomeDir -Recurse -Filter '*.bak' -File).Count | Should -Be 0
            ([IO.File]::ReadAllBytes($valuesPath) -join ',') | Should -Be $valuesBefore
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check matches' {
            Copy-EngineToRepo
            Copy-RepoDotfiles

            Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
            $script:EngineExit | Should -Be 0

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('This machine matches the repo.'))
            $script:EngineOut | Should -Not -Match '\[(CREATE|UPDATE)\s*\]'
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check sanitized' {
            Copy-EngineToRepo
            Copy-RepoDotfiles

            Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
            $script:EngineExit | Should -Be 0

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match (Get-StatusPattern 'UNCHANGED' 'dotfiles/windows/win.conf')
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore

            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            [IO.File]::AppendAllText($winConf, "editor = vim`r`n", [System.Text.UTF8Encoding]::new($false))

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 3
            $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATE' 'dotfiles/windows/win.conf')
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check needs values' {
            Copy-EngineToRepo
            Copy-RepoDotfiles

            $valuesPath = Join-Path $script:RepoDir '.user-values.json'
            Remove-Item -LiteralPath $valuesPath -Force

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 3
            $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/windows/win.conf' 'needs values: run mksync setup')
            $script:EngineOut | Should -Not -Match ([regex]::Escape('missing value for'))
            $script:EngineOut | Should -Not -Match ([regex]::Escape('Enter values to fill placeholders'))
            $valuesPath | Should -Not -Exist
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check dir' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            Copy-HomeFiles

            $localC = Join-Path $script:HomeDir '.config\fixture\dir\c.txt'
            [IO.File]::WriteAllText($localC, "c2`n", [System.Text.UTF8Encoding]::new($false))
            $mine = Join-Path $script:HomeDir '.config\fixture\dir\mine.txt'
            [IO.File]::WriteAllText($mine, "mine`n", [System.Text.UTF8Encoding]::new($false))

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 3
            $script:EngineOut | Should -Match (Get-StatusPattern 'UPDATE' 'dotfiles/common/dir/c.txt')
            $script:EngineOut | Should -Match (Get-StatusPattern 'EXTRA' 'dotfiles/common/dir/mine.txt' 'not in repo; kept')
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check missing folder' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            Copy-HomeFiles

            Add-FixtureEntry ([pscustomobject]@{
                repoPath    = 'dotfiles/windows/ghost.conf'
                localPath   = '~\.config\ghost\ghost.conf'
                platform    = 'windows'
                description = 'missing target folder fixture'
            })
            [IO.File]::WriteAllText((Join-Path $script:RepoDir 'dotfiles\windows\ghost.conf'), "ghost`r`n", [System.Text.UTF8Encoding]::new($false))

            $ghostDir = Join-Path $script:HomeDir '.config\ghost'
            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match (Get-StatusPattern 'SKIPPED' 'dotfiles/windows/ghost.conf' "WARNING: target folder not found: $ghostDir")
            $script:EngineOut | Should -Match ([regex]::Escape('This machine matches the repo.'))
            (Test-Path -LiteralPath $ghostDir) | Should -BeFalse
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check reset rejected' {
            Copy-EngineToRepo

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck -ResetValues

            $script:EngineExit | Should -Be 1
            $script:EngineOut | Should -Match ([regex]::Escape('ERROR: -Check cannot be combined with -ResetValues.'))
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check other user' {
            Copy-EngineToRepo

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck -User 'nobody-here'

            $script:EngineExit | Should -Be 1
            $script:EngineOut | Should -Not -Match ([regex]::Escape('Requesting elevation'))
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }

        It 'import check error' {
            Copy-EngineToRepo
            Copy-RepoDotfiles

            # A folder where the dir entry expects the repo's c.txt file. The
            # per-file catch inside Import-DirEntry turns that into an ERROR line.
            $localC = Join-Path $script:HomeDir '.config\fixture\dir\c.txt'
            $null = New-Item -ItemType Directory -Path $localC -Force

            $homeBefore = Get-TreeHash $script:HomeDir
            $repoBefore = Get-TreeHash $script:RepoDir

            Invoke-ImportCheck

            $script:EngineExit | Should -Be 1
            $script:EngineOut | Should -Match (Get-StatusPattern 'ERROR' 'dotfiles/common/dir/c.txt')
            $script:EngineOut | Should -Match ([regex]::Escape('1 error(s); see the ERROR lines above.'))
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
        }
    }

    # -- Front door -------------------------------------------------------------

    Context 'Front door' {
        It 'sync help' {
            Copy-EngineToRepo
            Copy-SyncWrappers

            Invoke-SyncCmd -CmdArgs @('help')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('usage: mksync [command] [options]'))
            $script:EngineOut | Should -Match ([regex]::Escape('Detected: windows'))
        }

        It 'status clean' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            New-GitRepo

            Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force

            Invoke-SyncStatus

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Origin    : up to date'))
            $script:EngineOut | Should -Match ([regex]::Escape('Unsent    : none'))
            $script:EngineOut | Should -Match ([regex]::Escape('Machine   : matches the repo'))
            $script:EngineOut | Should -Match ([regex]::Escape('Next: nothing to do.'))
        }

        It 'status behind' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            New-GitRepo

            # A second clone pushes one commit, so origin is ahead of this clone.
            $ErrorActionPreference = 'Continue'
            $other = Join-Path $script:T 'other'
            git clone -q (Join-Path $script:T 'origin.git') $other 2>$null
            [IO.File]::WriteAllText(
                (Join-Path $other 'dotfiles\windows\extra.conf'),
                "extra`n",
                [System.Text.UTF8Encoding]::new($false))
            git -C $other add -A 2>$null
            git -C $other -c user.name=t -c user.email=t@example.com commit -q -m second 2>$null
            git -C $other push -q origin master 2>$null

            Invoke-SyncStatus

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Origin    : 1 update(s) waiting'))
            $script:EngineOut | Should -Match ([regex]::Escape('Next: mksync pull'))
        }

        It 'status unsent' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            New-GitRepo

            [IO.File]::WriteAllText(
                (Join-Path $script:RepoDir 'dotfiles\windows\win.conf'),
                "user = Fixture User`r`n# unsent`r`n",
                [System.Text.UTF8Encoding]::new($false))

            Invoke-SyncStatus

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Unsent    : 1 changed file(s) not sent yet'))
            $script:EngineOut | Should -Match ([regex]::Escape('Next: mksync push'))
        }

        It 'status differs' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            New-GitRepo

            Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
            [IO.File]::WriteAllText(
                (Join-Path $script:HomeDir '.config\fixture\win.conf'),
                "user = Someone Else`r`n",
                [System.Text.UTF8Encoding]::new($false))
            Copy-SyncWrappers

            $repoBefore = Get-TreeHash $script:RepoDir
            $homeBefore = Get-TreeHash $script:HomeDir

            Invoke-SyncStatus

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Machine   : 1 file(s) differ from the repo'))
            (Get-TreeHash $script:RepoDir) | Should -Be $repoBefore
            (Get-TreeHash $script:HomeDir) | Should -Be $homeBefore
        }

        It 'status not git' {
            Copy-EngineToRepo

            Invoke-SyncStatus

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Origin    : not a git clone'))
            $script:EngineOut | Should -Match ([regex]::Escape('Next: run mksync doctor.'))
        }

        It 'status os name' {
            Copy-EngineToRepo

            Invoke-SyncStatus -OsName 'Test OS 1'

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('SyncSettings  windows (Test OS 1)'))
        }

        It 'doctor ready' {
            Copy-EngineToRepo
            New-GitRepo
            New-GhStub
            [IO.File]::WriteAllText(
                (Join-Path $script:BinDir 'mksync.cmd'),
                "@echo off`r`n`"$script:RepoDir\sync.cmd`" %*`r`n",
                [Text.Encoding]::ASCII)

            Invoke-SyncCmd -CmdArgs @('doctor')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Ready.'))
        }

        It 'doctor gh signed out' {
            Copy-EngineToRepo
            New-GitRepo
            New-GhStub -SignedOut

            Invoke-SyncCmd -CmdArgs @('doctor')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('gh: not signed in; run gh auth login'))
        }

        It 'doctor no launcher' {
            Copy-EngineToRepo
            New-GitRepo
            New-GhStub

            Invoke-SyncCmd -CmdArgs @('doctor')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('mksync not on PATH; run the installer again'))
        }
    }

    # -- Front door: pull and push ----------------------------------------------

    Context 'Front door pull and push' {
        BeforeAll {
            # A clone the front door can run in. The real repo never tracks the
            # values file, but New-CommitRepo commits it, so drop it and ignore
            # it as New-CommitValuesRepo does. Then apply the clone's repo to
            # the temp profile, so the machine matches the clone whatever the
            # runner's line-ending settings are.
            function Initialize-FrontRepo {
                New-CommitRepo -WithWrappers
                $ErrorActionPreference = 'Continue'
                git -C $script:CloneDir rm -q --cached .user-values.json 2>$null
                git -C $script:CloneDir -c user.name=t -c user.email=t@example.com commit -qm 'stop tracking the values' 2>$null
                git -C $script:CloneDir push -q origin master 2>$null
                Add-Content -LiteralPath (Join-Path $script:CloneDir '.git\info\exclude') -Value '.user-values.json'

                $importScript = Join-Path $script:CloneDir 'scripts\windows\Import-Settings.ps1'
                $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $importScript -Force 2>&1 | Out-String
            }
        }

        It 'pull applies' {
            Initialize-FrontRepo

            # A second clone pushes one commit that changes the Windows fixture.
            $ErrorActionPreference = 'Continue'
            $other = Join-Path $script:T 'other'
            git clone -q (Join-Path $script:T 'origin.git') $other 2>$null
            [IO.File]::WriteAllText(
                (Join-Path $other 'dotfiles\windows\win.conf'),
                "user = <NAME>`r`n# pulled`r`n",
                [System.Text.UTF8Encoding]::new($false))
            git -C $other add -A 2>$null
            git -C $other -c user.name=t -c user.email=t@example.com commit -q -m second 2>$null
            git -C $other push -q origin master 2>$null

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('pull', '--yes')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Pulled 1 commit(s).'))

            $head = (git -C $script:CloneDir rev-parse HEAD 2>$null | Out-String).Trim()
            $origin = (git -C $script:CloneDir rev-parse origin/master 2>$null | Out-String).Trim()
            $head | Should -Be $origin

            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            (Get-Content -LiteralPath $winConf -Raw) | Should -Match ([regex]::Escape('# pulled'))
            "$winConf.bak" | Should -Exist
        }

        It 'pull matches' {
            Initialize-FrontRepo

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('pull')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('This machine matches the repo.'))
        }

        It 'pull declined' {
            Initialize-FrontRepo

            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            [IO.File]::WriteAllText($winConf, "user = Someone Else`r`n", [System.Text.UTF8Encoding]::new($false))

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('pull') -InputText 'n'

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Nothing applied.'))
            (Get-Content -LiteralPath $winConf -Raw) | Should -Match ([regex]::Escape('Someone Else'))
        }

        It 'pull dirty' {
            Initialize-FrontRepo

            $winRepo = Join-Path $script:CloneDir 'dotfiles\windows\win.conf'
            [IO.File]::WriteAllText($winRepo, "user = <NAME>`r`n# local edit`r`n", [System.Text.UTF8Encoding]::new($false))

            $headBefore = (git -C $script:CloneDir rev-parse HEAD 2>$null | Out-String).Trim()

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('pull', '--yes')

            $script:EngineExit | Should -Be 1
            $script:EngineOut | Should -Match ([regex]::Escape('ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.'))
            (git -C $script:CloneDir rev-parse HEAD 2>$null | Out-String).Trim() | Should -Be $headBefore
        }

        It 'pull not master' {
            Initialize-FrontRepo

            $ErrorActionPreference = 'Continue'
            git -C $script:CloneDir switch -q -c other 2>$null

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('pull', '--yes')

            $script:EngineExit | Should -Be 1
            $script:EngineOut | Should -Match ([regex]::Escape('ERROR: pull needs the repo clone on master with an origin remote.'))
        }

        It 'push nothing' {
            Initialize-FrontRepo

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('push')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Nothing to send: the repo matches this machine.'))
            $script:GhLog | Should -Not -Exist
        }

        It 'push opens pr' {
            Initialize-FrontRepo

            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            [IO.File]::WriteAllText($winConf, "user = Fixture User`r`n# sent`r`n", [System.Text.UTF8Encoding]::new($false))

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('push', '--yes')

            $script:EngineExit | Should -Be 0
            (Get-Content -LiteralPath $script:GhLog -Raw) | Should -Match ([regex]::Escape('pr create'))
            Get-OriginBranches | Should -Match 'refs/heads/sync/windows-'
        }

        It 'push declined' {
            Initialize-FrontRepo

            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            [IO.File]::WriteAllText($winConf, "user = Fixture User`r`n# sent`r`n", [System.Text.UTF8Encoding]::new($false))

            Invoke-SyncCmd -Root $script:CloneDir -CmdArgs @('push') -InputText 'n'

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.'))
            $script:GhLog | Should -Not -Exist
            (git -C $script:CloneDir status --porcelain -- dotfiles 2>$null | Out-String).Trim() | Should -Not -Be ''
        }
    }

    # -- Front door: setup ------------------------------------------------------

    Context 'Front door setup' {
        It 'setup applies' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            New-GitRepo

            # The temp profile has the fixture folder but not the file, so the
            # check reports a CREATE and setup applies it. (Windows import skips
            # a file whose folder is missing.)
            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            $null = New-Item -ItemType Directory -Path (Split-Path $winConf -Parent) -Force
            $winConf | Should -Not -Exist

            Invoke-SyncCmd -CmdArgs @('setup', '--yes')

            $script:EngineExit | Should -Be 0
            $script:EngineOut | Should -Match ([regex]::Escape('Setup done.'))
            $winConf | Should -Exist
        }

        It 'setup doctor fails' {
            Copy-EngineToRepo
            Copy-RepoDotfiles
            New-GitRepo

            # A PATH with only the system folders: git is gone, but cmd.exe and
            # powershell.exe stay reachable for sync.cmd and the front door.
            $savedPath = $env:PATH
            $env:PATH = @(
                (Join-Path $env:SystemRoot 'System32'),
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
            ) -join ';'
            try {
                Invoke-SyncCmd -CmdArgs @('setup', '--yes')
            } finally {
                $env:PATH = $savedPath
            }

            $script:EngineExit | Should -Be 1
            $script:EngineOut | Should -Not -Match ([regex]::Escape('IMPORT CHECK'))
        }
    }

    # -- Installer --------------------------------------------------------------

    Context 'Installer' {
        BeforeAll {
            # Engine + fixtures + wrappers + install.ps1 committed on master and
            # pushed to a bare origin the installer clones from. The install
            # folder and its bin folder are separate temp paths.
            function Initialize-InstallRepo {
                Copy-EngineToRepo
                Copy-RepoDotfiles
                Copy-SyncWrappers
                Copy-Item -Path (Join-Path $Script:TestRepo 'install.ps1') -Destination $script:RepoDir -Force
                New-GitRepo
                $script:InstallOrigin = Join-Path $script:T 'origin.git'
                $script:InstallDir = Join-Path $script:T 'install'
                $script:InstallBin = Join-Path $script:T 'install-bin'
            }

            # Points every SYNCSETTINGS_* variable at the temp folders. A $null
            # in -Settings removes that variable (the setup case clears
            # SYNCSETTINGS_NO_SETUP); yes is the default, so no case prompts.
            function Set-InstallSettings {
                param([hashtable]$Settings = @{})
                $config = @{
                    SYNCSETTINGS_REPO_URL = $script:InstallOrigin
                    SYNCSETTINGS_DIR = $script:InstallDir
                    SYNCSETTINGS_REF = 'master'
                    SYNCSETTINGS_BIN = $script:InstallBin
                    SYNCSETTINGS_YES = '1'
                    SYNCSETTINGS_NO_SETUP = '1'
                }
                foreach ($name in @($Settings.Keys)) {
                    $config[$name] = $Settings[$name]
                }
                foreach ($name in @($config.Keys)) {
                    if ($null -eq $config[$name]) {
                        [Environment]::SetEnvironmentVariable($name, $null)
                    } else {
                        [Environment]::SetEnvironmentVariable($name, [string]$config[$name])
                    }
                }
            }

            # Runs install.ps1 the way the tests can: powershell.exe -File, so
            # its last line exits with Install-SyncSettings' code.
            function Invoke-Install {
                param([hashtable]$Settings = @{})
                Set-InstallSettings -Settings $Settings
                $script:InstallScriptPath = Join-Path $script:RepoDir 'install.ps1'
                $script:InstallOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:InstallScriptPath 2>&1 | Out-String
                $script:InstallExit = $LASTEXITCODE
            }

            # A cut-off download: every line but the last call runs through
            # Invoke-Expression, so the child sees $PSCommandPath unset.
            function Invoke-InstallPartial {
                Set-InstallSettings
                $text = [IO.File]::ReadAllText((Join-Path $script:RepoDir 'install.ps1')).TrimEnd("`r", "`n")
                $lines = $text -split "`r?`n"
                $partialPath = Join-Path $script:T 'install-cut-off.ps1'
                $partial = $lines[0..($lines.Count - 2)] -join "`r`n"
                [IO.File]::WriteAllText($partialPath, $partial, [System.Text.UTF8Encoding]::new($false))
                $env:SYNC_INSTALL_PARTIAL = $partialPath
                try {
                    $script:InstallOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'Invoke-Expression ([IO.File]::ReadAllText($env:SYNC_INSTALL_PARTIAL))' 2>&1 | Out-String
                    $script:InstallExit = $LASTEXITCODE
                } finally {
                    Remove-Item Env:\SYNC_INSTALL_PARTIAL -ErrorAction SilentlyContinue
                }
            }
        }

        BeforeEach {
            # The installer writes the bin folder into the user Path; keep the
            # real one and put it back after every case.
            $script:SavedUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $script:SavedLocalAppData = $env:LOCALAPPDATA
            $script:SavedWingetLog = $env:WINGET_LOG
            $script:SavedInstallEnv = @{}
            foreach ($name in @('SYNCSETTINGS_REPO_URL', 'SYNCSETTINGS_DIR', 'SYNCSETTINGS_REF',
                    'SYNCSETTINGS_BIN', 'SYNCSETTINGS_YES', 'SYNCSETTINGS_NO_SETUP')) {
                $script:SavedInstallEnv[$name] = [Environment]::GetEnvironmentVariable($name)
            }
            $env:LOCALAPPDATA = Join-Path $script:T 'localappdata'
            $null = New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force

            # A winget that only logs its arguments, first on PATH: no case can
            # reach the real winget or the network behind it.
            $script:WingetBinDir = Join-Path $script:T 'winget-bin'
            $null = New-Item -ItemType Directory -Path $script:WingetBinDir -Force
            $script:WingetLog = Join-Path $script:T 'winget.log'
            $body = "@echo off`r`necho %*>> `"%WINGET_LOG%`"`r`n"
            [IO.File]::WriteAllText((Join-Path $script:WingetBinDir 'winget.cmd'), $body, [Text.Encoding]::ASCII)
            $env:WINGET_LOG = $script:WingetLog
            $env:PATH = "$script:WingetBinDir;$env:PATH"

            # A stub gh as well, so no case reaches the real one; the
            # missing-gh case builds its own PATH without this folder.
            New-GhStub
        }

        AfterEach {
            if ($null -eq $script:SavedUserPath) {
                [Environment]::SetEnvironmentVariable('Path', $null, 'User')
            } else {
                [Environment]::SetEnvironmentVariable('Path', $script:SavedUserPath, 'User')
            }
            if ($null -eq $script:SavedLocalAppData) {
                Remove-Item Env:\LOCALAPPDATA -ErrorAction SilentlyContinue
            } else {
                $env:LOCALAPPDATA = $script:SavedLocalAppData
            }
            if ($null -eq $script:SavedWingetLog) {
                Remove-Item Env:\WINGET_LOG -ErrorAction SilentlyContinue
            } else {
                $env:WINGET_LOG = $script:SavedWingetLog
            }
            foreach ($name in @($script:SavedInstallEnv.Keys)) {
                [Environment]::SetEnvironmentVariable($name, $script:SavedInstallEnv[$name])
            }
        }

        It 'install fresh' {
            Initialize-InstallRepo

            Invoke-Install -Settings @{ SYNCSETTINGS_NO_SETUP = '1' }

            $script:InstallExit | Should -Be 0
            $script:InstallOut | Should -Match ([regex]::Escape('Cloned into'))
            $script:InstallOut | Should -Match ([regex]::Escape('Installed.'))

            $launcher = Join-Path $script:InstallBin 'mksync.cmd'
            $launcher | Should -Exist
            $lines = [IO.File]::ReadAllLines($launcher)
            $lines[0].Trim() | Should -Be '@echo off'
            $lines[1].Trim() | Should -Be 'rem SyncSettings launcher'

            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $userPath | Should -Match ([regex]::Escape($script:InstallBin))
        }

        It 'install update' {
            Initialize-InstallRepo

            Invoke-Install -Settings @{ SYNCSETTINGS_NO_SETUP = '1' }
            $script:InstallExit | Should -Be 0

            # A second clone pushes one commit, so the install folder is behind.
            $ErrorActionPreference = 'Continue'
            $other = Join-Path $script:T 'other'
            git clone -q $script:InstallOrigin $other 2>$null
            [IO.File]::WriteAllText(
                (Join-Path $other 'update.txt'),
                "second`n",
                [System.Text.UTF8Encoding]::new($false))
            git -C $other add -A 2>$null
            git -C $other -c user.name=t -c user.email=t@example.com commit -q -m second 2>$null
            git -C $other push -q origin master 2>$null

            Invoke-Install -Settings @{ SYNCSETTINGS_NO_SETUP = '1' }

            $script:InstallExit | Should -Be 0
            $script:InstallOut | Should -Match ([regex]::Escape('Updated'))
            $head = (git -C $script:InstallDir rev-parse HEAD 2>$null | Out-String).Trim()
            $originHead = (git -C $other rev-parse HEAD 2>$null | Out-String).Trim()
            $head | Should -Be $originHead
        }

        It 'install not a clone' {
            Initialize-InstallRepo

            $null = New-Item -ItemType Directory -Path $script:InstallDir -Force
            $keep = Join-Path $script:InstallDir 'keep.txt'
            [IO.File]::WriteAllText($keep, "keep`n", [System.Text.UTF8Encoding]::new($false))

            Invoke-Install -Settings @{ SYNCSETTINGS_NO_SETUP = '1' }

            $script:InstallExit | Should -Be 1
            $script:InstallOut | Should -Match ([regex]::Escape("exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR"))
            ([IO.File]::ReadAllText($keep)) | Should -BeExactly "keep`n"
        }

        It 'install launcher conflict' {
            Initialize-InstallRepo

            $null = New-Item -ItemType Directory -Path $script:InstallBin -Force
            $launcher = Join-Path $script:InstallBin 'mksync.cmd'
            $original = "@echo off`r`necho mine`r`n"
            [IO.File]::WriteAllText($launcher, $original, [Text.Encoding]::ASCII)

            Invoke-Install -Settings @{ SYNCSETTINGS_NO_SETUP = '1' }

            $script:InstallExit | Should -Be 1
            $script:InstallOut | Should -Match ([regex]::Escape('already exists; remove it and run this again.'))
            ([IO.File]::ReadAllText($launcher)) | Should -BeExactly $original
        }

        It 'install missing gh yes' {
            Initialize-InstallRepo

            # A PATH with git and the winget stub but no gh, so only gh is
            # missing and the yes answer installs it.
            $gitCommand = Get-Command git -CommandType Application | Select-Object -First 1
            $gitDir = Split-Path -Parent $gitCommand.Source
            $savedPath = $env:PATH
            $env:PATH = @(
                $script:WingetBinDir,
                $gitDir,
                (Join-Path $env:SystemRoot 'System32'),
                (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
            ) -join ';'
            try {
                Invoke-Install -Settings @{ SYNCSETTINGS_YES = '1'; SYNCSETTINGS_NO_SETUP = '1' }
            } finally {
                $env:PATH = $savedPath
            }

            $script:InstallExit | Should -Be 0
            (Get-Content -LiteralPath $script:WingetLog -Raw) | Should -Match ([regex]::Escape('GitHub.cli'))
        }

        It 'install partial' {
            Initialize-InstallRepo

            Invoke-InstallPartial

            $script:InstallExit | Should -Be 0
            $script:InstallDir | Should -Not -Exist
            (Join-Path $script:InstallBin 'mksync.cmd') | Should -Not -Exist
        }

        It 'install runs setup' {
            Initialize-InstallRepo

            # The temp profile has the fixture folder but not the file, so setup
            # applies a CREATE. (Windows import skips a missing folder.)
            $winConf = Join-Path $script:HomeDir '.config\fixture\win.conf'
            $null = New-Item -ItemType Directory -Path (Split-Path $winConf -Parent) -Force
            $winConf | Should -Not -Exist

            Invoke-Install -Settings @{ SYNCSETTINGS_YES = '1'; SYNCSETTINGS_NO_SETUP = $null }

            $script:InstallExit | Should -Be 0
            $script:InstallOut | Should -Match ([regex]::Escape('Setup done.'))
            $script:InstallOut | Should -Match ([regex]::Escape('Installed.'))
            $winConf | Should -Exist
        }
    }
}

Describe 'Request-MissingValues' {
    BeforeAll {
        . (Join-Path $Script:TestRepo "scripts\windows\SyncHelpers.ps1")
    }

    BeforeEach {
        Mock Read-Host { "" }
        # CI has no terminal, so these cases test the prompt path explicitly.
        Mock Test-Interactive { $true }
        $script:SavedFixtureEnv = $env:FIXTURE_ENV
    }

    AfterEach {
        Remove-Item Env:FIXTURE_ENV -ErrorAction SilentlyContinue
        if ($script:SavedFixtureEnv) {
            $env:FIXTURE_ENV = $script:SavedFixtureEnv
        }
    }

    It 'defaultEnv used' {
        $env:FIXTURE_ENV = 'abc'
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{}

        Request-MissingValues -Rules @($rule) -UserValues $values -Direction import

        $values['<X>'] | Should -Be 'abc'
        Should -Invoke Read-Host -Times 1 -Exactly
    }

    It 'default before defaultEnv' {
        $env:FIXTURE_ENV = 'abc'
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; default = 'd'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{}

        Request-MissingValues -Rules @($rule) -UserValues $values -Direction import

        $values['<X>'] | Should -Be 'd'
        Should -Invoke Read-Host -Times 1 -Exactly
    }

    It 'cached before default' {
        $env:FIXTURE_ENV = 'abc'
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; default = 'd'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{ '<X>' = 'c' }

        Request-MissingValues -Rules @($rule) -UserValues $values -Direction import -ForceAll

        $values['<X>'] | Should -Be 'c'
        Should -Invoke Read-Host -Times 1 -Exactly
    }

    It 'no default throws' {
        Remove-Item Env:FIXTURE_ENV -ErrorAction SilentlyContinue
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{}

        { Request-MissingValues -Rules @($rule) -UserValues $values -Direction import } | Should -Throw 'missing value for <X>: add it to .user-values.json'

        $values.ContainsKey('<X>') | Should -BeFalse
    }

    It 'interactive empty answer throws and stores nothing' {
        Mock Test-Interactive { $true }
        Mock Read-Host { '' }
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X' }
        $values = @{}

        { Request-MissingValues -Rules @($rule) -UserValues $values -Direction import } | Should -Throw 'missing value for <X>: add it to .user-values.json'

        $values.ContainsKey('<X>') | Should -BeFalse
        Should -Invoke Read-Host -Times 1 -Exactly
    }

    It 'non-interactive without default throws' {
        Mock Test-Interactive { $false }
        Remove-Item Env:FIXTURE_ENV -ErrorAction SilentlyContinue
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{}

        { Request-MissingValues -Rules @($rule) -UserValues $values -Direction import } | Should -Throw "missing value for <X>*"
        Should -Invoke Read-Host -Times 0 -Exactly
    }

    It 'non-interactive without default does not take the previous value' {
        Mock Test-Interactive { $false }
        $first = [pscustomobject]@{ placeholder = '<A>'; prompt = 'A'; default = 'd' }
        $second = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X' }
        $values = @{}

        { Request-MissingValues -Rules @($first, $second) -UserValues $values -Direction import } | Should -Throw "missing value for <X>*"

        $values.ContainsKey('<X>') | Should -BeFalse
    }

    It 'non-interactive takes default' {
        Mock Test-Interactive { $false }
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; default = 'd' }
        $values = @{}

        Request-MissingValues -Rules @($rule) -UserValues $values -Direction import

        $values['<X>'] | Should -Be 'd'
        Should -Invoke Read-Host -Times 0 -Exactly
    }
}

Describe 'Find-GitBash' {
    BeforeAll {
        . (Join-Path $Script:TestRepo "scripts\windows\SyncHelpers.ps1")
    }

    BeforeEach {
        $script:GitRoot = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path (Join-Path $script:GitRoot 'bin') -Force
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:GitRoot) {
            Remove-Item -LiteralPath $script:GitRoot -Recurse -Force
        }
    }

    It 'git in cmd' {
        [IO.File]::WriteAllText((Join-Path $script:GitRoot 'bin\bash.exe'), '')
        Mock Get-Command { [pscustomobject]@{ Source = (Join-Path $script:GitRoot 'cmd\git.exe') } } -ParameterFilter { $Name -eq 'git' }

        Find-GitBash | Should -Be (Join-Path $script:GitRoot 'bin\bash.exe')
    }

    It 'git in mingw64\bin' {
        [IO.File]::WriteAllText((Join-Path $script:GitRoot 'bin\bash.exe'), '')
        Mock Get-Command { [pscustomobject]@{ Source = (Join-Path $script:GitRoot 'mingw64\bin\git.exe') } } -ParameterFilter { $Name -eq 'git' }

        Find-GitBash | Should -Be (Join-Path $script:GitRoot 'bin\bash.exe')
    }

    It 'no bash.exe' {
        Mock Get-Command { [pscustomobject]@{ Source = (Join-Path $script:GitRoot 'cmd\git.exe') } } -ParameterFilter { $Name -eq 'git' }

        Find-GitBash | Should -BeNullOrEmpty
    }
}

Describe 'Test-RepoUpToDate' {
    BeforeAll {
        . (Join-Path $Script:TestRepo "scripts\windows\SyncHelpers.ps1")
    }

    BeforeEach {
        $ErrorActionPreference = "Continue"
        $script:Work = Join-Path $TestDrive 'work'
        $script:OriginRepo = Join-Path $TestDrive 'origin.git'
        $script:Second = Join-Path $TestDrive 'second'

        foreach ($dir in @($script:Work, $script:OriginRepo, $script:Second)) {
            if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        }

        New-Item -ItemType Directory -Path $script:Work | Out-Null
        git -C $script:Work init -q -b master
        Set-Content -Path (Join-Path $script:Work 'a.txt') -Value 'a'
        git -C $script:Work add -A
        git -C $script:Work -c user.name=t -c user.email=t@example.com commit -q -m init

        New-Item -ItemType Directory -Path $script:OriginRepo | Out-Null
        git -C $script:OriginRepo init -q --bare -b master
        git -C $script:Work remote add origin $script:OriginRepo
        git -C $script:Work push -q -u origin master

        git clone -q $script:OriginRepo $script:Second
        Set-Content -Path (Join-Path $script:Second 'b.txt') -Value 'b'
        git -C $script:Second add -A
        git -C $script:Second -c user.name=t -c user.email=t@example.com commit -q -m second
        git -C $script:Second push -q origin master

        $script:HeadBefore = (git -C $script:Work rev-parse HEAD).Trim()
    }

    It 'pull accepted stops the run' {
        Mock Test-Interactive { $true }
        Mock Read-Host { "y" }

        Test-RepoUpToDate -RepoRoot $script:Work | Should -BeTrue

        $head = (git -C $script:Work rev-parse HEAD).Trim()
        $origin = (git -C $script:Work rev-parse origin/master).Trim()
        $head | Should -Be $origin
    }

    It 'pull declined continues' {
        Mock Test-Interactive { $true }
        Mock Read-Host { "n" }

        Test-RepoUpToDate -RepoRoot $script:Work | Should -BeFalse

        (git -C $script:Work rev-parse HEAD).Trim() | Should -Be $script:HeadBefore
    }

    It 'non-interactive warns and continues' {
        Mock Test-Interactive { $false }
        Mock Read-Host { "" }

        Test-RepoUpToDate -RepoRoot $script:Work | Should -BeFalse

        Should -Invoke Read-Host -Times 0 -Exactly
    }
}

Describe 'Save-UserValues' {
    BeforeAll {
        . (Join-Path $Script:TestRepo "scripts\windows\SyncHelpers.ps1")

        function Assert-OnlyCurrentUser {
            param([string]$Path)
            $acl = Get-Acl -LiteralPath $Path
            $acl.AreAccessRulesProtected | Should -BeTrue
            $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })
            $sids | Should -Be @($current.Value)
        }
    }

    BeforeEach {
        $script:ValuesDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $script:ValuesDir -Force
    }

    AfterEach {
        Remove-Item -LiteralPath $script:ValuesDir -Recurse -Force
    }

    It 'values-private-new' {
        Save-UserValues -RepoRoot $script:ValuesDir -Values @{ '<X>' = 'y' }

        $path = Join-Path $script:ValuesDir '.user-values.json'
        Assert-OnlyCurrentUser $path
        (Get-UserValues -RepoRoot $script:ValuesDir)['<X>'] | Should -Be 'y'
    }

    It 'values-private-tightened' {
        $path = Join-Path $script:ValuesDir '.user-values.json'
        [IO.File]::WriteAllText($path, '{}')

        Save-UserValues -RepoRoot $script:ValuesDir -Values @{ '<X>' = 'y' }

        Assert-OnlyCurrentUser $path
    }
}

Describe 'Import-LinkedDirectory' {
    BeforeAll {
        . (Join-Path $Script:TestRepo "scripts\windows\SyncHelpers.ps1")
    }

    BeforeEach {
        $script:LinkedWork = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $script:LinkedWork -Force
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:LinkedWork) {
            Remove-Item -LiteralPath $script:LinkedWork -Recurse -Force
        }
    }

    It 'import-linked-answer-no' {
        $src = Join-Path $script:LinkedWork 'repo-tool'
        $dst = Join-Path $script:LinkedWork 'local-tool'
        $null = New-Item -ItemType Directory -Path $src -Force
        $null = New-Item -ItemType Directory -Path $dst -Force
        [IO.File]::WriteAllText((Join-Path $src 'a.txt'), "repo`n", [System.Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $dst 'a.txt'), "local`n", [System.Text.UTF8Encoding]::new($false))

        Mock Read-Host { 'n' }
        Mock Write-StatusLine { }

        $applied = Import-LinkedDirectory -SourceDir $src -DestDir $dst -Label 'tool' -ExcludePatterns @() -Force $false

        $applied | Should -Be 0
        ([IO.File]::ReadAllBytes((Join-Path $dst 'a.txt')) -join ',') | Should -Be ([Text.Encoding]::UTF8.GetBytes("local`n") -join ',')
        (Join-Path $dst 'a.txt.bak') | Should -Not -Exist
        Should -Invoke Read-Host -Times 1 -Exactly
        Should -Invoke Write-StatusLine -Times 1 -Exactly -ParameterFilter { $Status -eq 'SKIPPED' -and $Note -eq 'user skipped' }
    }

    It 'import-linked-error-continues' {
        $src = Join-Path $script:LinkedWork 'repo-tool'
        $dst = Join-Path $script:LinkedWork 'local-tool'
        $null = New-Item -ItemType Directory -Path $src -Force
        [IO.File]::WriteAllText((Join-Path $src 'a.txt'), "a`n", [System.Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $src 'b.txt'), "b`n", [System.Text.UTF8Encoding]::new($false))

        Mock Copy-RepoFileToLocal { if ($Label -like '*a.txt') { throw 'copy failed' }; 'CREATED' }
        Mock Write-StatusLine { }

        $applied = Import-LinkedDirectory -SourceDir $src -DestDir $dst -Label 'tool' -ExcludePatterns @() -Force $true

        $applied | Should -Be 1
        Should -Invoke Write-StatusLine -Times 1 -Exactly -ParameterFilter { $Status -eq 'ERROR' -and $Note -eq 'copy failed' }
    }

    It 'import-dir-error-continues' {
        $src = Join-Path $script:LinkedWork 'repo-tool'
        $dst = Join-Path $script:LinkedWork 'local-tool'
        $null = New-Item -ItemType Directory -Path $src -Force
        [IO.File]::WriteAllText((Join-Path $src 'a.txt'), "a`n", [System.Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $src 'b.txt'), "b`n", [System.Text.UTF8Encoding]::new($false))

        Mock Copy-RepoFileToLocal { if ($Label -like '*a.txt') { throw 'copy failed' }; 'CREATED' }
        Mock Write-StatusLine { }

        $applied = Import-DirEntry -RepoDir $src -LocalDir $dst -Label 'tool' -ExcludePatterns @() -Force $true

        $applied | Should -Be 1
        Should -Invoke Write-StatusLine -Times 1 -Exactly -ParameterFilter { $Status -eq 'ERROR' -and $Note -eq 'copy failed' }
    }
}
