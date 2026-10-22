$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path (Split-Path $PSScriptRoot) 'deployment-common.ps1')

function Assert-Equal($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', got '$Actual'" }
}

foreach ($FailAt in @('', 'switch', 'commit', 'verify', 'stopOld', 'rollback')) {
    $Events = [Collections.Generic.List[string]]::new()
    $Failed = $false
    try {
        Invoke-BridgeCutover -SwitchTraffic {
            $Events.Add('switch'); if ($FailAt -eq 'switch') { throw 'partial switch' }
        } -CommitConfig {
            $Events.Add('commit'); if ($FailAt -eq 'commit') { throw 'disk failure' }
        } -Verify {
            $Events.Add('verify'); if ($FailAt -in @('verify', 'rollback')) { throw 'unhealthy' }
        } -StopOld {
            $Events.Add('stopOld'); if ($FailAt -eq 'stopOld') { throw 'stop failed' }
        } -Rollback {
            $Events.Add('rollback'); if ($FailAt -eq 'rollback') { throw 'route failure' }
        } -StopCandidate { $Events.Add('stopCandidate') }
    } catch { $Failed = $true }
    if (-not $FailAt) {
        Assert-Equal $Failed $false
        Assert-Equal ($Events -join ',') 'switch,commit,verify,stopOld'
    } else {
        Assert-Equal $Failed $true
        Assert-Equal ($Events.Contains('rollback')) $true
        Assert-Equal ($Events.Contains('stopCandidate')) ($FailAt -ne 'rollback')
        if ($FailAt -ne 'stopOld') { Assert-Equal ($Events.Contains('stopOld')) $false }
    }
}

$Healthy = '{"ready":true,"activeTurns":{},"pendingRequests":0,"appServer":{"pendingRpc":0},"drafts":{"queuedMessages":0},"archive":{"busy":false},"queueDrains":0,"deployment":{"inFlight":0}}'
Assert-Equal (Test-BridgeIdle ($Healthy | ConvertFrom-Json)) $true
foreach ($Busy in @('turn', 'approval', 'rpc', 'queue', 'archive', 'drain', 'http')) {
    $Health = $Healthy | ConvertFrom-Json
    switch ($Busy) {
        'turn' { $Health.activeTurns = [pscustomobject]@{ thread = 'turn' } }
        'approval' { $Health.pendingRequests = 1 }
        'rpc' { $Health.appServer.pendingRpc = 1 }
        'queue' { $Health.drafts.queuedMessages = 1 }
        'archive' { $Health.archive.busy = $true }
        'drain' { $Health.queueDrains = 1 }
        'http' { $Health.deployment.inFlight = 1 }
    }
    Assert-Equal (Test-BridgeIdle $Health) $false
}
Write-Output 'deployment tests passed'
