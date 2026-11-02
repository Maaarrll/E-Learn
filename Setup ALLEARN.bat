@echo off
rem One-time setup on the classroom laptop.
rem Right-click this file and choose "Run as administrator".
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed.
  if exist "installers\node-*.msi" (
    echo Double-click the file in the "installers" folder to install it, then run this again.
  ) else (
    echo Install the LTS version from https://nodejs.org then run this again.
  )
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)" || (
  echo Node.js is too old. Install the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
rem The USB package already includes node_modules, so no internet is needed then
if not exist "node_modules\embedded-postgres" (
  echo Installing ALLEARN... ^(needs internet, this happens only once^)
  call npm install --omit=dev || (pause & exit /b 1)
)
echo Adding the "Start ALLEARN" icon to the desktop...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Start ALLEARN.lnk'); $s.TargetPath='%~dp0Start ALLEARN.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo Letting students' phones reach this laptop (Windows Firewall)...
netsh advfirewall firewall delete rule name="ALLEARN" >nul 2>nul
netsh advfirewall firewall add rule name="ALLEARN" dir=in action=allow protocol=TCP localport=3000 >nul 2>nul && echo Firewall: OK || echo Firewall: not changed. Run this file as administrator, or click "Allow" when Windows asks the first time.
echo.
echo Setup done. Double-click "Start ALLEARN" on the desktop to begin.
pause
