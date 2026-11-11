@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0host\setup.ps1" %*
set "setup_result=%errorlevel%"
echo.
if not "%setup_result%"=="0" echo Installation failed. See the message above.
echo Press any key to close this window.
pause >nul
exit /b %setup_result%
