@echo off
REM 前台运行：日志直接打印在窗口，Ctrl+C 停止服务。
REM 想后台开机自启请用 install_autostart.ps1（注册到 Task Scheduler，pythonw 无窗口）。
REM 提示：如果当前已有 pythonw server.py 在跑（来自 Task Scheduler），会因为端口 5454 占用而失败。
REM       先 Stop-ScheduledTask -TaskName TennisToDoSync 或在任务管理器结束 pythonw.exe。
chcp 65001 >nul
cd /d "%~dp0"
python server.py
