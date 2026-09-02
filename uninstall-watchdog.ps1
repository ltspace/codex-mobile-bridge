$ErrorActionPreference = 'Stop'

$TaskName = 'Codex Mobile Bridge Watchdog'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host 'Codex Mobile Bridge watchdog removed. The bridge itself was not stopped.'
