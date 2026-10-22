function Test-BridgeIdle([object]$Health) {
    if (-not $Health -or -not $Health.ready) { return $false }
    if ($Health.activeTurns -and @($Health.activeTurns.PSObject.Properties).Count -gt 0) { return $false }
    if ($Health.pendingRequests -gt 0 -or $Health.appServer.pendingRpc -gt 0) { return $false }
    if ($Health.drafts.queuedMessages -gt 0 -or $Health.archive.busy) { return $false }
    if ($Health.PSObject.Properties['queueDrains'] -and $Health.queueDrains -gt 0) { return $false }
    if ($Health.PSObject.Properties['deployment'] -and $Health.deployment.inFlight -gt 0) { return $false }
    return $true
}

function Write-BridgeDeploymentLease([string]$Path) {
    $Temporary = "$Path.$PID.tmp"
    @{ expiresAt = (Get-Date).ToUniversalTime().AddMinutes(5).ToString('o'); ownerPid = $PID } |
        ConvertTo-Json | Set-Content -LiteralPath $Temporary -Encoding utf8
    Move-Item -LiteralPath $Temporary -Destination $Path -Force
}

function Invoke-BridgeCutover {
    param(
        [scriptblock]$SwitchTraffic,
        [scriptblock]$CommitConfig,
        [scriptblock]$Verify,
        [scriptblock]$StopOld,
        [scriptblock]$Rollback,
        [scriptblock]$StopCandidate
    )
    # A command may change Serve and then throw during verification. Always try
    # rollback, including when SwitchTraffic itself throws after making changes.
    try {
        & $SwitchTraffic
        & $CommitConfig
        & $Verify
        & $StopOld
    } catch {
        $Failure = $_
        try { & $Rollback } catch {
            throw "Cutover failed ($($Failure.Exception.Message)); rollback also failed ($($_.Exception.Message)). Both instances were retained for recovery."
        }
        & $StopCandidate
        throw $Failure
    }
}
