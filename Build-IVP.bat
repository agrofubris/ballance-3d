@echo off
rem Optional: build the exact IVP physics module the original game used.
rem   Build-IVP.bat                      build into .local\ivp-simulation
rem   Build-IVP.bat "<Ballance app>"     also install it into an unpacked desktop release
call "%~dp0Setup-Ballance.bat" --ivp %1
