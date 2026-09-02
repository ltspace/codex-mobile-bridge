$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

$Config = Get-BridgeConfig
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$WScriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$HiddenHostPath = Join-Path $Config.Root 'watchdog-hidden.vbs'
$Arguments = "//B //NoLogo `"$HiddenHostPath`""

$Action = New-ScheduledTaskAction -Execute $WScriptPath -Argument $Arguments -WorkingDirectory $Config.Root
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$PeriodicTrigger = New-ScheduledTaskTrigger -Once `
    -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -MultipleInstances IgnoreNew

$Task = New-ScheduledTask `
    -Action $Action `
    -Trigger @($LogonTrigger, $PeriodicTrigger) `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'Runs an idempotent Codex mobile bridge health and Tailscale Serve check every minute.'
$ExistingTask = Get-ScheduledTask -TaskName $Config.TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Stop-ScheduledTask -TaskName $Config.TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}
Register-ScheduledTask -TaskName $Config.TaskName -InputObject $Task -Force | Out-Null
Start-ScheduledTask -TaskName $Config.TaskName
Start-Sleep -Seconds 2

$Registered = Get-ScheduledTask -TaskName $Config.TaskName
$Info = Get-ScheduledTaskInfo -TaskName $Config.TaskName
Write-Host "Watchdog installed: $($Config.TaskName)"
Write-Host "State=$($Registered.State) NextRun=$($Info.NextRunTime)"
