@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Запустить.ps1"
set "SMENA_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %SMENA_EXIT_CODE%
