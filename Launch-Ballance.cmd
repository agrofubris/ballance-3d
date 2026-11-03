@echo off
rem Keep the original entry point compatible with the automatic .bat launcher.
call "%~dp0Launch-Ballance.bat" %*
exit /b %errorlevel%
