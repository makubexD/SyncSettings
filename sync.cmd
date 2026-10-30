@echo off
rem One command for the sync flow on Windows: preview, export, commit, import.
rem The bash sync wrapper hands over here on Git Bash, MSYS and Cygwin.
setlocal EnableExtensions
pushd "%~dp0"

set "RC=1"
set "COMMAND=%~1"
if not defined COMMAND goto usage
if /i "%COMMAND%"=="help" goto usage
if /i "%COMMAND%"=="-h" goto usage

rem Re-quote the remaining arguments so a value with spaces stays one argument.
set "REST="
shift
:gather
if "%~1"=="" goto gathered
set "REST=%REST% "%~1""
shift
goto gather
:gathered

set "SCRIPT="
if /i "%COMMAND%"=="preview" set "SCRIPT=Export-Settings.ps1"
if /i "%COMMAND%"=="export"  set "SCRIPT=Export-Settings.ps1"
if /i "%COMMAND%"=="commit"  set "SCRIPT=Commit-Settings.ps1"
if /i "%COMMAND%"=="import"  set "SCRIPT=Import-Settings.ps1"
if not defined SCRIPT goto unknown

if /i "%COMMAND%"=="preview" set "REST=-Preview %REST%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\%SCRIPT%" %REST%
set "RC=%ERRORLEVEL%"
goto done

:usage
echo usage: sync.cmd ^<preview^|export^|commit^|import^> [options]
echo   Detected: windows
set "RC=0"
goto done

:unknown
echo Unknown command: %COMMAND%
echo usage: sync.cmd ^<preview^|export^|commit^|import^> [options]
goto done

:done
popd
exit /b %RC%
