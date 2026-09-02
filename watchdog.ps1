$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

$LogDirectory = Join-Path $PSScriptRoot 'logs'
$StateDirectory = Join-Path $PSScriptRoot 'state'
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogPath = Join-Path $LogDirectory 'watchdog.log'
$StatePath = Join-Path $StateDirectory 'watchdog-state.json'
$Mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileBridgeWatchdogCheck')
$LifecycleLock = $null
$Config = $null
$FailureThreshold = 3
$FailureGraceSeconds = 120

if ($env:BRIDGE_WATCHDOG_FAILURE_THRESHOLD -and [int]::TryParse($env:BRIDGE_WATCHDOG_FAILURE_THRESHOLD, [ref]$FailureThreshold)) {
    $FailureThreshold = [Math]::Max(1, [Math]::Min(10, $FailureThreshold))
}
if ($env:BRIDGE_WATCHDOG_GRACE_SECONDS -and [int]::TryParse($env:BRIDGE_WATCHDOG_GRACE_SECONDS, [ref]$FailureGraceSeconds)) {
    $FailureGraceSeconds = [Math]::Max(30, [Math]::Min(600, $FailureGraceSeconds))
}

function Write-WatchdogLog([string]$Message) {
    $Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $LogPath -Value "$Timestamp $Message" -Encoding utf8
}

function Get-WatchdogHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.LocalPort)/api/health" -TimeoutSec 4 } catch { return $null }
}

function Read-WatchdogState {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    try { return Get-Content -LiteralPath $StatePath -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $null }
}

function Write-WatchdogState([int]$Failures, [string]$FirstFailureAt, [string]$Reason) {
    New-Item -ItemType Directory -Path $Config.StateDir -Force | Out-Null
    $Temporary = "$StatePath.$PID.tmp"
    [ordered]@{
        consecutiveHealthFailures = $Failures
        firstFailureAt = $FirstFailureAt
        lastReason = $Reason
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $Temporary -Encoding utf8
    Move-Item -LiteralPath $Temporary -Destination $StatePath -Force
}

function Repair-BridgeServe {
    & $Config.TailscalePath serve --bg --yes --https=$($Config.HttpsPort) "http://127.0.0.1:$($Config.LocalPort)" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-BridgeServe $Config)) { throw 'Tailscale Serve repair failed.' }
}

try {
    if (-not $Mutex.WaitOne(0)) { exit 0 }
    $LifecycleLock = Enter-BridgeLifecycleLock
    $Config = Get-BridgeConfig
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1MB) {
        Rotate-BridgeLog $LogPath 3
    }

    $Health = Get-WatchdogHealth
    $ServeReady = Test-BridgeServe $Config
    if ($Health -and $Health.ready) {
        Write-WatchdogState 0 $null $null
        if (-not $ServeReady) {
            Write-WatchdogLog 'Tailscale Serve rule is missing; repairing without restarting the bridge.'
            Repair-BridgeServe
            Write-WatchdogLog 'Tailscale Serve repair completed and verified.'
        }
        exit 0
    }

    $Process = Get-BridgeProcess $Config
    $Listener = Get-NetTCPConnection -LocalPort $Config.LocalPort -State Listen -ErrorAction SilentlyContinue |
        Where-Object { -not $Process -or $_.OwningProcess -eq $Process.ProcessId } |
        Select-Object -First 1
    $ImmediateRecovery = -not $Process -or -not $Listener

    $Previous = Read-WatchdogState
    $PreviousFailures = if ($Previous -and $Previous.PSObject.Properties['consecutiveHealthFailures']) { [int]$Previous.consecutiveHealthFailures } else { 0 }
    $FirstFailureAt = if ($PreviousFailures -gt 0 -and $Previous.firstFailureAt) { [string]$Previous.firstFailureAt } else { (Get-Date).ToUniversalTime().ToString('o') }
    $Failures = $PreviousFailures + 1
    $Reason = if (-not $Process) { 'process_missing' } elseif (-not $Listener) { 'listener_missing' } else { 'health_not_ready' }
    Write-WatchdogState $Failures $FirstFailureAt $Reason

    $FailureAgeSeconds = try { ((Get-Date).ToUniversalTime() - [datetime]::Parse($FirstFailureAt).ToUniversalTime()).TotalSeconds } catch { 0 }
    if (-not $ImmediateRecovery -and $Failures -lt $FailureThreshold -and $FailureAgeSeconds -lt $FailureGraceSeconds) {
        Write-WatchdogLog "Recovery deferred: $Reason, consecutive=$Failures/$FailureThreshold, age=$([Math]::Round($FailureAgeSeconds))s/$($FailureGraceSeconds)s."
        if (-not $ServeReady) {
            Write-WatchdogLog 'Tailscale Serve rule is also missing; repairing it independently.'
            Repair-BridgeServe
        }
        exit 0
    }

    Write-WatchdogLog "Bridge recovery started: $Reason, consecutive=$Failures, age=$([Math]::Round($FailureAgeSeconds))s."
    & (Join-Path $Config.Root 'start.ps1') -SkipServe -LifecycleLockHeld 2>&1 | Out-File -LiteralPath $LogPath -Append -Encoding utf8
    if (-not (Test-BridgeServe $Config)) { Repair-BridgeServe }

    $VerifiedHealth = Get-WatchdogHealth
    $VerifiedServe = Test-BridgeServe $Config
    if (-not (($VerifiedHealth -and $VerifiedHealth.ready) -and $VerifiedServe)) {
        throw 'Recovery command completed but verification failed.'
    }
    Write-WatchdogState 0 $null $null
    Write-WatchdogLog 'Bridge recovery completed and verified.'
} catch {
    Write-WatchdogLog "Recovery failed: $($_.Exception.Message)"
    exit 1
} finally {
    if ($LifecycleLock) { Exit-BridgeLifecycleLock $LifecycleLock }
    try { $Mutex.ReleaseMutex() } catch {}
    $Mutex.Dispose()
}
