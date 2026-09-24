@echo off
rem The Sidle of Milch - double-click to play.
rem Uses the exported game (games\sidle-of-milch\build\SidleOfMilch.exe) when it exists; otherwise runs the
rem project directly in Godot 4.7 .NET (install it once with: node apps\cli\bin\aige.mjs godot setup).
setlocal
set "GAME=%~dp0games\sidle-of-milch"
if exist "%GAME%\build\SidleOfMilch.exe" (
  start "" "%GAME%\build\SidleOfMilch.exe"
  exit /b 0
)
set "GODOT=%USERPROFILE%\.aige\godot\Godot_v4.7.2-stable_mono_win64\Godot_v4.7.2-stable_mono_win64.exe"
if not exist "%GODOT%" (
  echo Godot 4.7 .NET is not installed. Run:  node apps\cli\bin\aige.mjs godot setup
  pause
  exit /b 1
)
if not exist "%GAME%\project.godot" (
  echo The game has not been exported yet. Run:  node apps\cli\bin\aige.mjs godot export -p games\sidle-of-milch
  pause
  exit /b 1
)
start "" "%GODOT%" --path "%GAME%"
