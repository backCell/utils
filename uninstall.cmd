@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0uninstall.js"
if errorlevel 1 pause
