[CmdletBinding(SupportsShouldProcess)]
param([switch]$Disable, [switch]$Bootstrap)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')
$Config = Get-BridgeConfig
if (-not $Disable) {
    $Task = Get-ScheduledTask -TaskName $Config.TaskName -ErrorAction Stop
    if ($Task.State -eq 'Disabled') { throw 'Enable the watchdog task before installing automatic updates.' }
    $Health = Get-BridgeHealth $Config 5
    if (-not $Health -or -not $Health.ready) { throw 'The bridge must be healthy before enabling automatic updates.' }
    if (-not $Health.PSObject.Properties['deployment'] -and -not $Bootstrap) { throw 'Use -Bootstrap once to deploy the gate from the watchdog session.' }
}
if ($PSCmdlet.ShouldProcess($Config.ConfigPath, $(if ($Disable) { 'Disable automatic Codex CLI updates' } else { 'Enable stable Codex CLI updates through the existing watchdog' }))) {
    $Lock = Enter-BridgeLifecycleLock
    try {
        Update-BridgeLocalConfig @{ autoUpdateEnabled = -not [bool]$Disable; autoUpdateBootstrap = (-not $Disable -and [bool]$Bootstrap) } | Out-Null
        if (-not $Disable) { Set-Content -LiteralPath (Join-Path $Config.StateDir 'auto-update-request') -Value 'check' -Encoding ascii }
    }
    finally { Exit-BridgeLifecycleLock $Lock }
    Write-Host $(if ($Disable) { 'Automatic updates disabled. The installed runtime is unchanged.' } else { 'Automatic updates enabled: stable npm release check every 15 minutes, idle retries every minute.' })
}
