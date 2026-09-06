@echo off
rem ---------------------------------------------------------------------------
rem  Add a blueprint to the reference library.
rem
rem  Drag .sbp + .sbpcfg pairs (or a .cbp world export) onto the desktop
rem  shortcut that points here. The files are copied into the gitignored
rem  sources folder, decoded, and the decoded folder is opened.
rem
rem  Double-clicked with nothing dropped, it just opens the sources folder so
rem  files can be put there by hand, then decodes whatever is present.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

rem Resolve to a real absolute path so messages do not print "scripts\..\".
for %%I in ("%~dp0..") do set "REPO=%%~fI"
set "SRC=%REPO%\reference\blueprints\sources"
set "OUT=%REPO%\reference\blueprints\decoded"

if not exist "%SRC%" mkdir "%SRC%"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH. Install it, or run the ingest by hand:
  echo     node scripts\ingest-blueprint-reference.mjs
  echo.
  pause
  exit /b 1
)

set /a ADDED=0
set /a SKIPPED=0

if "%~1"=="" (
  echo.
  echo   Nothing dropped - opening the sources folder.
  echo   Put .sbp + .sbpcfg pairs, or a .cbp export, in there.
  echo.
  start "" "%SRC%"
  goto decode
)

echo.
echo   Copying blueprints into the library...
echo.

:copyloop
if "%~1"=="" goto decode
set "EXT=%~x1"
if /i "!EXT!"==".sbp"    goto accept
if /i "!EXT!"==".sbpcfg" goto accept
if /i "!EXT!"==".cbp"    goto accept
echo     skipped  %~nx1  ^(not a blueprint file^)
set /a SKIPPED+=1
shift
goto copyloop

:accept
rem Dropping a file that already lives in the library is normal, not a failure:
rem copy refuses to put a file onto itself.
if /i "%~f1"=="%SRC%\%~nx1" (
  echo     already  %~nx1
  set /a ADDED+=1
  shift
  goto copyloop
)
copy /Y "%~1" "%SRC%\" >nul
if errorlevel 1 (
  echo     FAILED   %~nx1
) else (
  echo     added    %~nx1
  set /a ADDED+=1
)
shift
goto copyloop

:decode
echo.
if not "%~1"=="" echo.
echo   Decoding...
echo.
pushd "%REPO%"
node scripts\ingest-blueprint-reference.mjs
set "RESULT=%errorlevel%"
popd

echo.
if not "%RESULT%"=="0" (
  echo   The ingest reported a problem ^(exit %RESULT%^). Nothing was published.
  echo.
  pause
  exit /b %RESULT%
)

echo   Done. !ADDED! file^(s^) added, !SKIPPED! skipped.
echo.
echo   Read the sheet for a design in:
echo     %OUT%
echo.
echo   A .sbp needs its matching .sbpcfg - drop both, or the pair is ignored.
echo.
start "" "%OUT%"
pause
endlocal
exit /b 0
