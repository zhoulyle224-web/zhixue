@echo off
cd /d "%~dp0"
python scripts\build_demo_database.py
if errorlevel 1 goto :failed
python scripts\check_demo_database.py
if errorlevel 1 goto :failed
echo.
echo 数据库已生成并通过检查：data\zhixue_demo.sqlite
pause
exit /b 0

:failed
echo.
echo 数据库生成或检查失败，请把本窗口内容发给 Codex。
pause
exit /b 1
