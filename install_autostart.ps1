# 注册 Windows Task Scheduler 任务，登录时自动后台启动 scripts\server.py
# 用法：在本目录右键 → 用 PowerShell 运行（不需要管理员）
# 卸载：Unregister-ScheduledTask -TaskName TennisToDoSync -Confirm:$false

$dir     = $PSScriptRoot
$scripts = Join-Path $dir 'scripts'

# 自动挑 venv 的 pythonw（如果有），否则用系统 pythonw
$venvPyw = Join-Path $dir '.venv\Scripts\pythonw.exe'
$exe     = if (Test-Path $venvPyw) { $venvPyw } else { 'pythonw' }

$action  = New-ScheduledTaskAction -Execute $exe `
              -Argument 'server.py' -WorkingDirectory $scripts
$trig    = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName 'TennisToDoSync' `
    -Action $action -Trigger $trig -Settings $set -Force `
    -Description 'SJTU tennis booking -> Microsoft To-Do sync daemon' | Out-Null

Start-ScheduledTask -TaskName 'TennisToDoSync'

Write-Host '已注册并启动 TennisToDoSync。' -ForegroundColor Green
Write-Host '  使用的 Python：' -NoNewline; Write-Host $exe -ForegroundColor Cyan
Write-Host '  日志：       ' -NoNewline; Write-Host (Join-Path $dir 'data\server.log') -ForegroundColor Cyan
Write-Host '  查看状态：   ' -NoNewline; Write-Host 'Get-ScheduledTask TennisToDoSync | Get-ScheduledTaskInfo' -ForegroundColor Cyan
Write-Host '  卸载：       ' -NoNewline; Write-Host 'Unregister-ScheduledTask -TaskName TennisToDoSync -Confirm:`$false' -ForegroundColor Cyan
