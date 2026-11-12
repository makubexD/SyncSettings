@echo off
rem Runs once, at the end of the Windows install (dockurr/windows copies /oem to C:\OEM).
powershell -NoProfile -ExecutionPolicy Bypass -File C:\OEM\setup.ps1 > C:\OEM\setup.log 2>&1
