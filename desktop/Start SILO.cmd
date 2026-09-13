@echo off
where node.exe >nul 2>nul
if errorlevel 1 goto fallback
node.exe "%~dp0launch.mjs"
exit /b %errorlevel%
:fallback
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-silo.ps1"
