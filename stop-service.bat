@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\stop-zhixue.ps1"
if errorlevel 1 (
  echo.
  echo 停止失败，请查看上方错误信息。
  pause
  exit /b 1
)
endlocal
