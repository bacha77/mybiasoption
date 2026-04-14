@echo off
echo [SYSTEM] Attempting to clear Port 3000 conflicts...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    echo [SYSTEM] Found zombie process PID: %%a. Killing it...
    taskkill /f /pid %%a
)
echo [SYSTEM] Port 3000 should be clear now.
pause
