[CmdletBinding()]
param(
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$WindowsPrincipal = [Security.Principal.WindowsPrincipal]::new($Identity)
$IsAdministrator = $WindowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdministrator) {
    if ($Elevated) { throw 'Administrator rights are required to register the non-interactive watchdog task.' }
    $ElevationArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"
    $ElevatedProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList $ElevationArguments `
        -Verb RunAs `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($ElevatedProcess.ExitCode -ne 0) {
        throw "Elevated watchdog installation failed with exit code $($ElevatedProcess.ExitCode)."
    }
    Write-Host 'Watchdog installed in a non-interactive session.'
    return
}

$Config = Get-BridgeConfig
$CurrentUser = $Identity.Name
$PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$WatchdogPath = Join-Path $Config.Root 'watchdog.ps1'
$Arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatchdogPath`""

$Action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments -WorkingDirectory $Config.Root
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$PeriodicTrigger = New-ScheduledTaskTrigger -Once `
    -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType S4U -RunLevel Limited
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
    -Description 'Runs a non-interactive Codex mobile bridge health and Tailscale Serve check every minute.'
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
if ($Registered.Principal.LogonType -ne 'S4U') {
    throw "Watchdog registration is not non-interactive: $($Registered.Principal.LogonType)"
}
Write-Host "Watchdog installed: $($Config.TaskName)"
Write-Host "State=$($Registered.State) LogonType=$($Registered.Principal.LogonType) NextRun=$($Info.NextRunTime)"
