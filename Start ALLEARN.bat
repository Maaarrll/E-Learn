@echo off
title ALLEARN - keep this window open during class
cd /d "%~dp0"
rem Use the Node.js inside this folder (portable package), else an installed one
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" scripts\classroom.mjs || (
  echo.
  echo ALLEARN stopped because of an error. Take a photo of this window for support.
  pause
)
