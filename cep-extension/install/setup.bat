@echo off
setlocal
echo Starting Arknight setup - checking installed components...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" echo Setup failed. See the error above.
pause
exit /b %result%
