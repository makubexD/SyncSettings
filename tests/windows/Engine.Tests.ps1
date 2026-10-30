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
    function Invoke-SyncCmd {
        param([string[]]$CmdArgs = @())
        $script:EngineScript = Join-Path $script:RepoDir 'sync.cmd'
        $script:EngineOut = & cmd.exe /c $script:EngineScript @CmdArgs 2>&1 | Out-String
        $script:EngineExit = $LASTEXITCODE
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

        $msg = [regex]::Escape('ERROR: sync-config.json: entry dotfiles/linux/plain.txt needs "platform": "common", "windows" or "linux".')

        Invoke-Engine -ScriptName 'Export-Settings.ps1'
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $msg

        Invoke-Engine -ScriptName 'Import-Settings.ps1' -Force
        $script:EngineExit | Should -Be 1
        $script:EngineOut | Should -Match $msg

        @(Get-ChildItem -Path $script:HomeDir -Recurse -File).Count | Should -Be 0
        (Join-Path $script:RepoDir 'dotfiles') | Should -Not -Exist
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

    # -- sync.cmd ---------------------------------------------------------------

    It 'sync-cmd-usage' {
        Copy-EngineToRepo
        Copy-SyncWrappers

        Invoke-SyncCmd

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('usage: sync.cmd <preview|export|commit|import> [options]'))
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
            $script:EngineOut = & .\sync 2>&1 | Out-String
            $script:EngineExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        $script:EngineExit | Should -Be 0
        $script:EngineOut | Should -Match ([regex]::Escape('Detected: windows'))
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

    It 'no default leaves value unset' {
        Remove-Item Env:FIXTURE_ENV -ErrorAction SilentlyContinue
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{}

        Request-MissingValues -Rules @($rule) -UserValues $values -Direction import

        $values.ContainsKey('<X>') | Should -BeFalse
    }

    It 'non-interactive without default throws' {
        Mock Test-Interactive { $false }
        Remove-Item Env:FIXTURE_ENV -ErrorAction SilentlyContinue
        $rule = [pscustomobject]@{ placeholder = '<X>'; prompt = 'X'; defaultEnv = 'FIXTURE_ENV' }
        $values = @{}

        { Request-MissingValues -Rules @($rule) -UserValues $values -Direction import } | Should -Throw "missing value for <X>*"
        Should -Invoke Read-Host -Times 0 -Exactly
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
}
