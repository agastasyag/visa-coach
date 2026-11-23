@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing once...
  call npm install --no-audit --no-fund
)
start "" http://localhost:5178
node server.js
