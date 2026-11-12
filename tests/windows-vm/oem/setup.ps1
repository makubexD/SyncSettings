# One-time guest setup: Git (MinGit), Pester 5, and the job agent started at every logon.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# PortableGit, not MinGit: the engine's leak scan runs Git's bin\bash.exe, as on the CI runners.
$gitVersion = '2.47.1'
$gitExe = "C:\OEM\portablegit.7z.exe"
Invoke-WebRequest -UseBasicParsing -OutFile $gitExe `
    "https://github.com/git-for-windows/git/releases/download/v$gitVersion.windows.1/PortableGit-$gitVersion-64-bit.7z.exe"
if (Test-Path 'C:\Tools\git') { Remove-Item -LiteralPath 'C:\Tools\git' -Recurse -Force }
Start-Process -FilePath $gitExe -ArgumentList @('-oC:\Tools\git', '-y') -Wait
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
[Environment]::SetEnvironmentVariable('Path', "$machinePath;C:\Tools\git\cmd", 'Machine')
& 'C:\Tools\git\cmd\git.exe' config --system user.name 'vm'
& 'C:\Tools\git\cmd\git.exe' config --system user.email 'vm@example.com'
& 'C:\Tools\git\cmd\git.exe' config --system init.defaultBranch master
& 'C:\Tools\git\cmd\git.exe' config --system core.autocrlf true
& 'C:\Tools\git\cmd\git.exe' config --system safe.directory '*'

# Defender's real-time scan makes the suites several times slower; the test folders hold only the repo's files.
Add-MpPreference -ExclusionPath 'C:\work', 'C:\Tools', "$env:LOCALAPPDATA\Temp" -ErrorAction SilentlyContinue
Add-MpPreference -ExclusionProcess 'powershell.exe', 'git.exe', 'bash.exe' -ErrorAction SilentlyContinue

Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope AllUsers | Out-Null
Install-Module Pester -MinimumVersion 5.5.0 -Force -SkipPublisherCheck -Scope AllUsers

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\OEM\start.ps1'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'SyncSettingsAgent' -Action $action -Trigger $trigger -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'SyncSettingsAgent'
