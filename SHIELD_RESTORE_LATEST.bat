@echo off
setlocal
echo ==================================================
echo [SHIELD] ⚠️  EMERGENCY SYSTEM ROLLBACK
echo ==================================================
echo.
if not exist "shield_backups\last_good.txt" (
    echo [ERROR] No previous snapshots found.
    pause
    exit /b
)

set /p LATEST=<shield_backups\last_good.txt

echo [SYSTEM] Restoring system to: %LATEST%
echo [CAUTION] This will overwrite your current src and public folders.
echo.
set /p CONFIRM="Proceed with Rollback? (Y/N): "
if /i "%CONFIRM%" neq "Y" (
    echo [ABORTED] Rollback cancelled.
    pause
    exit /b
)

npm run rollback %LATEST%
echo.
echo [SYSTEM] Rollback complete. Please RESTART your server.
pause
