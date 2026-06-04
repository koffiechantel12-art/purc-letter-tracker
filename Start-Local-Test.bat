@echo off
setlocal
cd /d "%~dp0\.."
set PORT=8092
"C:\Users\shantel\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" render-app\server.mjs
