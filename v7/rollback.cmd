@echo off
rem ============================================================
rem  v7 rollback: redeploy the production deployment to the version
rem  saved in last_good_version.txt by the previous deploy.cmd run.
rem  Usage: rollback.cmd            (uses last_good_version.txt)
rem         rollback.cmd 74         (explicit version number)
rem  2026-10-08 added (field app v2 plan: "5-minute rollback").
rem ============================================================
setlocal
cd /d "%~dp0"
set PROD_ID=AKfycbwV8eVN6KJvfMnQLkNmbOqYsjpvQSJTCqk40kfyMFzRjxFItJ8-4VxOV4U9MojLH4U
set CLASP=C:\nodejs-global\clasp.cmd

set VER=%~1
if "%VER%"=="" if exist last_good_version.txt set /p VER=<last_good_version.txt
if "%VER%"=="" (
  echo ABORT: no version given and last_good_version.txt is missing
  exit /b 1
)

echo Rolling production back to version @%VER% ...
call "%CLASP%" deploy --deploymentId %PROD_ID% --versionNumber %VER% --description "rollback to @%VER%"
if errorlevel 1 (
  echo FAILED: clasp deploy error
  exit /b 1
)
call "%CLASP%" deployments | findstr /c:"%PROD_ID%"
echo ping:
curl -sL "https://script.google.com/macros/s/%PROD_ID%/exec?action=ping"
echo.
echo DONE: production now serves @%VER% (check the build value above)
exit /b 0
