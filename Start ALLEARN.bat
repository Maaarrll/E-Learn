@echo off
title ALLEARN - keep this window open during class
cd /d "%~dp0"
node scripts\classroom.mjs
echo.
echo ALLEARN stopped. If you see an error above, take a photo of it for support.
pause
