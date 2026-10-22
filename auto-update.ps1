[CmdletBinding()]
param([switch]$ForceCheck, [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')
. (Join-Path $PSScriptRoot 'deployment-common.ps1')
$Mutex = [Threading.Mutex]::new($false, 'Global\CodexMobileBridgeAutoUpdate')
$Locked = $false
$UpdateState = $null
$StatePath = Join-Path $PSScriptRoot 'state\auto-update.json'
$LogPath = Join-Path $PSScriptRoot 'logs\auto-update.log'

function Save-UpdateState {
    $UpdateState.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    $Temporary = "$StatePath.$PID.tmp"
    $UpdateState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Temporary -Encoding utf8
    Move-Item -LiteralPath $Temporary -Destination $StatePath -Force
}

try {
    try { $Locked = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Locked = $true }
    if (-not $Locked) { return }
    $Local = Read-BridgeLocalConfig
    if (-not $CheckOnly -and -not (Get-BridgeConfigValue $Local 'autoUpdateEnabled')) { return }
    $WakeupPath = Join-Path $PSScriptRoot 'state\auto-update-request'
    if (Test-Path -LiteralPath $WakeupPath) {
        $ForceCheck = $true
        Remove-Item -LiteralPath $WakeupPath -Force
    }
    $Previous = if (Test-Path -LiteralPath $StatePath) { Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } else { $null }
    if (-not $ForceCheck -and $Previous -and $Previous.nextCheckAt -and [datetime]::Parse($Previous.nextCheckAt).ToUniversalTime() -gt (Get-Date).ToUniversalTime()) { return }
    $Config = Get-BridgeConfig
    New-Item -ItemType Directory -Path $Config.StateDir, $Config.LogDir -Force | Out-Null
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1MB) { Rotate-BridgeLog $LogPath 3 }
    $UpdateState = [ordered]@{
        status = 'checking'; lastCheckedAt = (Get-Date).ToUniversalTime().ToString('o')
        nextCheckAt = (Get-Date).ToUniversalTime().AddMinutes(15).ToString('o')
        fromVersion = $null; version = $null; error = $null; updatedAt = $null
    }
    Save-UpdateState
    $NpmCommand = Resolve-BridgeExecutable -CommandNames @('npm.cmd') -FallbackPaths @((Join-Path (Split-Path $Config.NodePath) 'npm.cmd'))
    if (-not $NpmCommand) { throw 'npm.cmd was not found.' }
    $NpmCli = Join-Path (Split-Path $NpmCommand) 'node_modules\npm\bin\npm-cli.js'
    $ReleaseArgs = @((Join-Path $Config.Root 'src\codex-release.mjs'), $NpmCli, $Config.CodexCommand)
    if ($CheckOnly) { $ReleaseArgs += '--check-only' }
    $PreparedJson = & $Config.NodePath @ReleaseArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Stable release preparation failed; see $LogPath" }
    $Release = ($PreparedJson -join "`n") | ConvertFrom-Json
    $UpdateState.status = $Release.status
    $UpdateState.fromVersion = $Release.fromVersion
    $UpdateState.version = $Release.version
    $Bootstrap = [bool](Get-BridgeConfigValue $Local 'autoUpdateBootstrap')
    if ($Release.status -eq 'prepared' -or ($Bootstrap -and -not $CheckOnly -and $Release.status -eq 'up_to_date')) {
        # Downloading never holds the lifecycle lock. Recheck enablement and idle
        # just before deployment; bluegreen takes the cross-session lock itself.
        if (-not (Get-BridgeConfigValue (Read-BridgeLocalConfig) 'autoUpdateEnabled')) { $UpdateState.status = 'disabled'; Save-UpdateState; return }
        $Health = Get-BridgeHealth (Get-BridgeConfig) 5
        if (-not (Test-BridgeIdle $Health)) {
            $UpdateState.status = 'waiting_for_idle'
            $UpdateState.nextCheckAt = (Get-Date).ToUniversalTime().AddMinutes(1).ToString('o')
        } elseif (-not $Health.PSObject.Properties['deployment'] -and -not $Bootstrap) {
            throw 'Install the deployment gate with a one-time blue-green restart before enabling updates.'
        } else {
            $UpdateState.status = 'switching'; Save-UpdateState
            $NextCommand = if ($Release.status -eq 'prepared') { $Release.command } else { $Config.CodexCommand }
            & (Join-Path $Config.Root 'bluegreen-restart.ps1') -CodexCommand $NextCommand -ExpectedCodexCommand $Config.CodexCommand -ExpectedCurrentVersion $Release.fromVersion -AllowLegacySource:$Bootstrap *>&1 | Out-File -LiteralPath $LogPath -Append -Encoding utf8
            $ActiveConfig = Get-BridgeConfig
            $Health = Get-BridgeHealth $ActiveConfig 5
            if (-not $Health.ready -or $Health.deployment.blocked -or $ActiveConfig.CodexCommand -ne $NextCommand -or -not (Test-BridgeServe $ActiveConfig)) { throw 'Final runtime verification failed.' }
            if ($Bootstrap) {
                $ConfigLock = Enter-BridgeLifecycleLock
                try { Update-BridgeLocalConfig @{ autoUpdateBootstrap = $false } | Out-Null }
                finally { Exit-BridgeLifecycleLock $ConfigLock }
            }
            $UpdateState.status = 'updated'
        }
    }
    Save-UpdateState
    Add-Content -LiteralPath $LogPath -Value "$($UpdateState.updatedAt) $($UpdateState.status) $($Release.fromVersion) -> $($Release.version)" -Encoding utf8
    $UpdateState | ConvertTo-Json -Depth 5
} catch {
    if ($UpdateState) {
        $UpdateState.error = $_.Exception.Message
        $Busy = $UpdateState.error -match 'BRIDGE_BUSY|BRIDGE_CHANGED'
        $UpdateState.status = if ($Busy) { 'waiting_for_idle' } else { 'failed' }
        $UpdateState.nextCheckAt = (Get-Date).ToUniversalTime().AddMinutes($(if ($Busy) { 1 } else { 360 })).ToString('o')
        Save-UpdateState
        Add-Content -LiteralPath $LogPath -Value "$($UpdateState.updatedAt) $($UpdateState.status): $($UpdateState.error)" -Encoding utf8
        Add-Content -LiteralPath $LogPath -Value $_.ScriptStackTrace -Encoding utf8
    }
    throw
} finally {
    if ($Locked) { $Mutex.ReleaseMutex() }
    $Mutex.Dispose()
}
