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
