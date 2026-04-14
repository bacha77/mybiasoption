@echo off
setlocal
echo ==================================================
echo [SHIELD] 📂 SYSTEM SNAPSHOT BROWSER
echo ==================================================
echo.
node scripts/safety-shield.js --restore
echo.
echo [INFO] To restore a specific version, use: 
echo        npm run rollback YYYY-MM-DD_HH-mm
echo.
pause
