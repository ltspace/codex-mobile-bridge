[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$')]
    [string]$ThreadId,

    [Parameter(Mandatory = $true)]
    [string]$RolloutPath,

    [ValidateRange(1, 180)]
    [int]$WaitTimeoutMinutes = 60,

    [string]$ExpectedTurnIdsCsv = '',

    [switch]$NormalizeLfOnly,

    [long]$ExpectedCursorOffset = 0,

    [long]$ExpectedCursorOrdinal = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'bridge-common.ps1')
$ExpectedTurnIds = @($ExpectedTurnIdsCsv.Split(',', [StringSplitOptions]::RemoveEmptyEntries))

$Deadline = (Get-Date).AddMinutes($WaitTimeoutMinutes)
$IdleObservations = 0
do {
    $Config = Get-BridgeConfig
    $Health = Get-BridgeHealth $Config 3
    $ActiveTurns = if ($Health -and $Health.activeTurns) { @($Health.activeTurns.PSObject.Properties).Count } else { -1 }
    $PendingRequests = if ($Health) { [int]$Health.pendingRequests } else { -1 }
    $ArchiveBusy = [bool]($Health -and $Health.archive -and $Health.archive.busy)
    if ($Health -and $Health.ready -and $ActiveTurns -eq 0 -and $PendingRequests -eq 0 -and -not $ArchiveBusy) {
        $IdleObservations += 1
    } else {
        $IdleObservations = 0
    }
    if ($IdleObservations -ge 2) { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $Deadline)

if ($IdleObservations -lt 2) { throw 'Timed out waiting for the Bridge to become idle.' }

$Stopped = $false
$Started = $false
try {
    & (Join-Path $PSScriptRoot 'stop.ps1') -KeepServe
    $Stopped = $true

    $LockPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) ".codex\thread-writer-locks\$ThreadId.lock"
    $ProbeScript = Join-Path $PSScriptRoot 'src\find-thread-writer.ps1'
    $WriterDeadline = (Get-Date).AddSeconds(30)
    do {
        $WriterCount = 0
        if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
            $Probe = (& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ProbeScript -LockPath $LockPath) | ConvertFrom-Json
            $WriterCount = @($Probe.owners).Count
        }
        if ($WriterCount -eq 0) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $WriterDeadline)
    if ($WriterCount -ne 0) { throw 'The old Bridge App Server still owns the target thread lock; repair was refused.' }

    if ($NormalizeLfOnly) {
        $Repair = & (Join-Path $PSScriptRoot 'normalize-repaired-rollout.ps1') -ThreadId $ThreadId -RolloutPath $RolloutPath -ExpectedCursorOffset $ExpectedCursorOffset -ExpectedCursorOrdinal $ExpectedCursorOrdinal | ConvertFrom-Json
    } else {
        $Repair = & (Join-Path $PSScriptRoot 'repair-thread-history.ps1') -ThreadId $ThreadId -RolloutPath $RolloutPath | ConvertFrom-Json
    }

    & (Join-Path $PSScriptRoot 'start.ps1')
    $Started = $true

    $Config = Get-BridgeConfig
    $Health = Get-BridgeHealth $Config 5
    if (-not ($Health -and $Health.ready -and $Health.version -eq '0.8.1')) {
        throw 'The repaired Bridge did not start as version 0.8.1.'
    }
    if (-not (Test-BridgeServe $Config)) { throw 'Tailscale Serve does not point to the repaired Bridge.' }

    $ProjectionRefresh = $null
    if ($ExpectedTurnIds.Count -gt 0) {
        $ProjectionRefresh = & $Config.NodePath (Join-Path $PSScriptRoot 'refresh-thread-projection.mjs') $Config.CodexCommand $ThreadId | ConvertFrom-Json
    }

    $EncodedThreadId = [uri]::EscapeDataString($ThreadId)
    $ProjectionDeadline = (Get-Date).AddSeconds(90)
    do {
        $Turns = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.LocalPort)/api/threads/$EncodedThreadId/turns?limit=10" -TimeoutSec 45
        $ReturnedTurnIds = @($Turns.data | ForEach-Object { [string]$_.id })
        $MissingTurnIds = @($ExpectedTurnIds | Where-Object { $_ -notin $ReturnedTurnIds })
        if ($MissingTurnIds.Count -eq 0) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $ProjectionDeadline)
    if ($MissingTurnIds.Count -gt 0) { throw "Recovered history is still missing expected turns: $($MissingTurnIds -join ', ')." }

    [pscustomobject]@{
        status = 'complete'
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        version = $Health.version
        bridgePid = (Get-Content -LiteralPath $Config.PidPath -Raw).Trim()
        threadId = $ThreadId
        returnedTurns = $ReturnedTurnIds.Count
        finalOrdinal = if ($Repair.PSObject.Properties['newFinalOrdinal']) { $Repair.newFinalOrdinal } elseif ($Repair.PSObject.Properties['finalOrdinal']) { $Repair.finalOrdinal } else { $null }
        repairedRecords = if ($Repair.PSObject.Properties['repairedRecords']) { $Repair.repairedRecords } else { 0 }
        backupPath = $Repair.backupPath
        tailscaleServe = $true
        projectionRefresh = $ProjectionRefresh
    } | ConvertTo-Json -Depth 4
} finally {
    if ($Stopped -and -not $Started) {
        try { & (Join-Path $PSScriptRoot 'start.ps1') } catch { Write-Error "Bridge recovery restart also failed: $($_.Exception.Message)" }
    }
}
