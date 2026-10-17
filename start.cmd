@echo off
rem Starts RGB Studio and opens it in your browser. It closes by itself once you close the tab.
cd /d "%~dp0"
if not exist node_modules\three (
  echo Installing dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)
start "RGB Studio" /min node server.js --open
