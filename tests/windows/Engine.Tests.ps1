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
}

Describe 'Windows engine' {
    BeforeEach {
        $script:T = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $script:T
        $script:HomeDir = Join-Path $script:T 'home'
        $null = New-Item -ItemType Directory -Path (Join-Path $script:HomeDir '.config\fixture') -Force
        $script:SavedUserProfile = $env:USERPROFILE
        $env:USERPROFILE = $script:HomeDir
    }

    AfterEach {
        $env:USERPROFILE = $script:SavedUserProfile
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
}
