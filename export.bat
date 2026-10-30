@echo off
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\Export-Settings.ps1" %*
popd
pause
