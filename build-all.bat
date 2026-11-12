@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo ============================================================
echo    XYRON CENTER - BUILD PIPELINE
echo ============================================================
echo.
echo [1/4] Exporting full source to TXT...
call node export-to-txt.js
echo.
echo [2/4] Installing dependencies (node-pty ships prebuilt, no compiler needed)...
call npm install --no-audit --no-fund
if not exist "node_modules\electron\dist\electron.exe" (
  echo [2b] Fetching Electron runtime binary...
  call node node_modules\electron\install.js
)
echo.
echo [3/4] Running tests...
call npm run test:fast
if errorlevel 1 (
  echo Tests failed - aborting build.
  pause
  exit /b 1
)
echo.
echo [4/4] Packaging (unpacked app folder, manifest = requireAdministrator)...
call npm run build
echo.
echo Build complete.
echo   App:  ..\3_Final_EXE_Uygulama\win-unpacked\XyronCenter.exe
echo   Note: the unpacked folder starts instantly; a portable single-file EXE
echo         has to unpack ~240 MB to %%TEMP%% on EVERY launch, which is slow.
echo.
pause
