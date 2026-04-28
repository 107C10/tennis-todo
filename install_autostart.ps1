# 注册 Windows Task Scheduler 任务，登录时自动启动 server.py
# 用法：在本目录下右键 → 用 PowerShell 运行（不需要管理员）
# 卸载：Unregister-ScheduledTask -TaskName TennisToDoSync -Confirm:$false

$dir    = $PSScriptRoot
$action = New-ScheduledTaskAction -Execute "pythonw" `
            -Argument "server.py" -WorkingDirectory $dir
$trig   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set    = New-ScheduledTaskSettingsSet -StartWhenAvailable `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName "TennisToDoSync" `
    -Action $action -Trigger $trig -Settings $set -Force `
    -Description "SJTU 网球预约 → Microsoft To-Do 自动同步守护进程" | Out-Null

Start-ScheduledTask -TaskName "TennisToDoSync"

Write-Host "已注册并启动 TennisToDoSync。" -ForegroundColor Green
Write-Host ""
Write-Host "  查看运行状态：" -NoNewline
Write-Host "Get-ScheduledTask TennisToDoSync | Get-ScheduledTaskInfo" -ForegroundColor Cyan
Write-Host "  日志：       " -NoNewline
Write-Host "$dir\server.log" -ForegroundColor Cyan
Write-Host "  卸载：       " -NoNewline
Write-Host "Unregister-ScheduledTask -TaskName TennisToDoSync -Confirm:`$false" -ForegroundColor Cyan
