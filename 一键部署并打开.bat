@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0scripts\deploy-and-open.ps1" (
  echo.
  echo 启动文件不完整。请先完整解压 ZIP，再双击本文件。
  echo 不要直接在压缩包预览窗口中运行。
  pause
  exit /b 2
)
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-and-open.ps1" %*
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方错误信息；数据不会丢失。
  echo 修复后可再次双击本文件重试。
  pause
)
endlocal
