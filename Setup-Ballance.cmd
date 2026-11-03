@echo off
rem CMD-compatible entry point for the repo-local setup wizard.
call "%~dp0Setup-Ballance.bat" %*
exit /b %errorlevel%
