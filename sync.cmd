@echo off
rem One command for the sync flow on Windows: status, doctor, setup, pull,
rem push, diff, and the single steps preview, check, export, commit, import.
rem The bash sync wrapper hands over here on Git Bash, MSYS and Cygwin.
setlocal EnableExtensions
pushd "%~dp0"

set "RC=1"
set "COMMAND=%~1"
if /i "%COMMAND%"=="help" goto usage
if /i "%COMMAND%"=="-h" goto usage

rem Re-quote the remaining arguments so a value with spaces stays one argument.
rem FRONT_ARGS also maps the Linux spellings pull, push and setup accept.
set "REST="
set "FRONT_ARGS="
shift
:gather
if "%~1"=="" goto gathered
set "ARG=%~1"
set "FRONT_ARG="
if /i "%ARG%"=="--yes" set "FRONT_ARG=-Yes"
if /i "%ARG%"=="--no-fetch" set "FRONT_ARG=-NoFetch"
if /i "%ARG%"=="--force" set "FRONT_ARG=-Force"
if /i not "%ARG%"=="-m" goto gather_plain
rem -m <msg> becomes -Message <msg> for Front.ps1.
set "REST=%REST% "%~1""
set "FRONT_ARGS=%FRONT_ARGS% "-Message""
shift
if "%~1"=="" goto gathered
set "REST=%REST% "%~1""
set "FRONT_ARGS=%FRONT_ARGS% "%~1""
shift
goto gather
:gather_plain
if not defined FRONT_ARG set "FRONT_ARG=%ARG%"
set "REST=%REST% "%~1""
set "FRONT_ARGS=%FRONT_ARGS% "%FRONT_ARG%""
shift
goto gather
:gathered

set "SCRIPT="
if /i "%COMMAND%"=="preview" set "SCRIPT=Export-Settings.ps1"
if /i "%COMMAND%"=="check"   set "SCRIPT=Import-Settings.ps1"
if /i "%COMMAND%"=="export"  set "SCRIPT=Export-Settings.ps1"
if /i "%COMMAND%"=="commit"  set "SCRIPT=Commit-Settings.ps1"
if /i "%COMMAND%"=="import"  set "SCRIPT=Import-Settings.ps1"
if defined SCRIPT goto engine

rem Everything else is the front door: status, doctor, setup, pull, push, diff,
rem or an unknown command, which stops here. No command shows the status.
set "FRONT="
if /i "%COMMAND%"=="status" set "FRONT=status"
if /i "%COMMAND%"=="doctor" set "FRONT=doctor"
if /i "%COMMAND%"=="setup"  set "FRONT=setup"
if /i "%COMMAND%"=="pull"   set "FRONT=pull"
if /i "%COMMAND%"=="push"   set "FRONT=push"
if /i "%COMMAND%"=="diff"   set "FRONT=diff"
if not defined COMMAND set "FRONT=status"
if not defined FRONT goto unknown
if /i "%FRONT%"=="status" set "FRONT_ARGS="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\Front.ps1" %FRONT% %FRONT_ARGS%
set "RC=%ERRORLEVEL%"
goto done

:engine
if /i "%COMMAND%"=="preview" set "REST=-Preview %REST%"
if /i "%COMMAND%"=="check" set "REST=-Check %REST%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\%SCRIPT%" %REST%
set "RC=%ERRORLEVEL%"
goto done

:unknown
echo Unknown command: %COMMAND%
echo usage: mksync [command] [options]; run sync.cmd help
goto done

:usage
echo usage: mksync [command] [options]
echo   ^(none^)   show where this machine stands and what to run next
echo   doctor   check the tools and the setup
echo   setup    first run on this machine
echo   pull     get the latest repo and apply it here
echo   push     send this machine's changes as a PR
echo   diff     which side changed each file, after a fetch
echo   preview ^| check ^| export ^| commit ^| import   the single steps
echo   Detected: windows
set "RC=0"
goto done

:done
popd
exit /b %RC%
