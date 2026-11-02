@echo off
title ALLEARN - keep this window open during class
cd /d "%~dp0"
node scripts\classroom.mjs || (
  echo.
  echo ALLEARN stopped because of an error. Take a photo of this window for support.
  pause
)
