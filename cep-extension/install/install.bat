@echo off
rem ==============================================================
rem  Arknight Auto Editing - CEP extension installer (wrapper)
rem
rem  This .bat is intentionally ASCII-only: cmd.exe mis-decodes
rem  non-ASCII bytes in batch sources under some code pages.
rem  All user-facing output comes from install.ps1, which handles
rem  UTF-8 correctly.
rem ==============================================================

cd /d "%~dp0"

echo Installing Arknight Auto Editing CEP extension...
echo.

rem --------------------------------------------------------------
rem  Make sure install.ps1 starts with a UTF-8 BOM.
rem
rem  Windows PowerShell 5.1 decodes a BOM-less file using the system
rem  ANSI codepage (GBK on a Simplified-Chinese machine). The Chinese
rem  literals in install.ps1 then turn into garbage, and multi-byte
rem  sequences can even eat quotes/braces and break parsing with
rem  confusing syntax errors. Adding the BOM makes it parse as UTF-8.
rem
rem  This is a no-op when the BOM is already present, so it also
rem  protects contributors whose editor strips BOMs on save.
rem --------------------------------------------------------------
powershell -NoProfile -Command "$p='%~dp0install.ps1';$b=[IO.File]::ReadAllBytes($p);if($b.Length -lt 3 -or $b[0] -ne 0xEF -or $b[1] -ne 0xBB -or $b[2] -ne 0xBF){[IO.File]::WriteAllBytes($p,[byte[]](0xEF,0xBB,0xBF)+$b);Write-Host '[info] Added missing UTF-8 BOM to install.ps1'}"

rem Pass through any args, e.g.:
rem   install.bat -PremiereDir "D:\your-path\Adobe Premiere Pro 2025"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo [FAILED] Exit code %RC%. See the message above.
) else (
    echo [DONE] Restart Premiere Pro, then open:
    echo        Window ^> Extensions ^> Arknight Auto Editing
)
echo.
pause
exit /b %RC%
