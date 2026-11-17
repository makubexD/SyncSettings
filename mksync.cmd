@echo off
rem Run the program from the clone on Bun or Node (phase 9, decision 2).
rem MKSYNC_RUNTIME=bun^|node picks the runtime; unset, the first installed of
rem Bun then Node. Node must be 22.18 or newer, since that is where it runs the
rem TypeScript source without a flag. MKSYNC_LAUNCHER=1 tells the program it
rem runs from the clone, so `mksync update` asks for git pull instead of
rem downloading. Usage: mksync.cmd [command] [arguments]
setlocal
set "MKSYNC_LAUNCHER=1"

set "RUNTIME="
if not defined MKSYNC_RUNTIME goto pick_default
if /i "%MKSYNC_RUNTIME%"=="bun" goto runtime_bun
if /i "%MKSYNC_RUNTIME%"=="node" goto runtime_node
>&2 echo ERROR: MKSYNC_RUNTIME must be bun or node.
exit /b 2

:runtime_bun
set "RUNTIME=bun"
goto check_runtime

:runtime_node
set "RUNTIME=node"
goto check_runtime

:pick_default
where bun >nul 2>nul
if errorlevel 1 (
    set "RUNTIME=node"
) else (
    set "RUNTIME=bun"
)
goto check_runtime

:check_runtime
where %RUNTIME% >nul 2>nul
if errorlevel 1 goto no_runtime
if /i not "%RUNTIME%"=="node" goto run

rem Node's version, compared as numbers per field: 22.18.0 or newer passes.
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2,3 delims=." %%a in ('node -p "process.versions.node" 2^>nul') do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
if not defined NODE_MAJOR goto no_runtime
if %NODE_MAJOR% LSS 22 goto no_runtime
if %NODE_MAJOR% GTR 22 goto run
if %NODE_MINOR% LSS 18 goto no_runtime
goto run

:no_runtime
>&2 echo ERROR: mksync needs Bun or Node 22.18 or newer to run from the clone.
exit /b 2

:run
%RUNTIME% "%~dp0src\main.ts" %*
exit /b %ERRORLEVEL%
