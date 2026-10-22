[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(0, 65535)]
    [int]$CandidatePort = 0,

    [string]$CodexCommand,

    [string]$ExpectedCodexCommand,
    [string]$ExpectedCurrentVersion,

    # One-time migration only; automatic updates always require the drain gate.
    [switch]$AllowLegacySource
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')
. (Join-Path $PSScriptRoot 'deployment-common.ps1')

function Select-CandidatePort([int]$CurrentPort, [int]$RequestedPort) {
    $Candidates = if ($RequestedPort) {
        @($RequestedPort)
    } else {
        @($(if ($CurrentPort -eq 8765) { 8766 } else { 8765 })) + @(8766..8799)
    }
    foreach ($Port in $Candidates | Select-Object -Unique) {
        if ($Port -eq $CurrentPort) { continue }
        $Owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $Owner) { return $Port }
    }
    throw 'No free candidate port was found in the range 8765-8799.'
}

function Get-CandidateHealth([int]$Port, [int]$TimeoutSeconds = 3) {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSeconds } catch { return $null }
}

function Test-CandidateApi([int]$Port) {
    $Models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/models" -TimeoutSec 30
    if (-not $Models.data -or @($Models.data).Count -eq 0) { throw 'Candidate returned an empty model catalog.' }
    $Threads = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/threads?limit=10" -TimeoutSec 30
    if (-not $Threads.PSObject.Properties['data']) { throw 'Candidate returned an invalid thread list.' }
}

function Set-ServeTarget([object]$Config, [int]$LocalPort) {
    & $Config.TailscalePath serve --bg --yes --https=$($Config.HttpsPort) "http://127.0.0.1:$LocalPort" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to point Tailscale Serve at port $LocalPort." }
    $Expected = $Config.PSObject.Copy()
    $Expected.LocalPort = $LocalPort
    if (-not (Test-BridgeServe $Expected)) {
        throw "Tailscale Serve did not confirm port $LocalPort."
    }
}

function Get-ProcessId([object]$Process) {
    if (-not $Process) { return $null }
    if ($Process.PSObject.Properties['ProcessId']) { return [int]$Process.ProcessId }
    if ($Process.PSObject.Properties['Id']) { return [int]$Process.Id }
    return $null
}

function Stop-OwnedProcess([object]$Process) {
    $ProcessId = Get-ProcessId $Process
    if (-not $ProcessId -or -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
    $Deadline = (Get-Date).AddSeconds(8)
    while ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $Deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    }
}

$LifecycleLock = Enter-BridgeLifecycleLock
$Config = $null
$OldProcess = $null
$CandidateProcess = $null
$Switched = $false
$CutoverState = @{ RetainCandidate = $false }
$LeasePath = $null
$OriginalEnvironment = @{}
$EnvironmentNames = @('BRIDGE_HOST', 'BRIDGE_PORT', 'BRIDGE_UI_LANGUAGE', 'BRIDGE_STATE_FILE', 'CODEX_COMMAND')

try {
    $Config = Get-BridgeConfig
    if ($ExpectedCodexCommand -and $Config.CodexCommand -ne $ExpectedCodexCommand) { throw 'BRIDGE_CHANGED: the selected runtime changed during preparation.' }
    if ($ExpectedCurrentVersion) {
        $CurrentVersionOutput = (& $Config.CodexCommand --version) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $CurrentVersionOutput.Trim() -ne "codex-cli $ExpectedCurrentVersion") { throw 'BRIDGE_CHANGED: the installed CLI version changed during preparation.' }
    }
    if ($env:BRIDGE_PORT -or $env:BRIDGE_CODEX_COMMAND) { throw 'Remove BRIDGE_PORT/BRIDGE_CODEX_COMMAND overrides before a persistent blue-green switch.' }
    if (-not $CodexCommand) { $CodexCommand = $Config.CodexCommand }
    if (-not (Test-Path -LiteralPath $CodexCommand -PathType Leaf)) { throw "Codex command not found: $CodexCommand" }
    $OldProcess = Get-BridgeProcess $Config
    $OldHealth = if ($OldProcess) { Get-BridgeHealth $Config 5 } else { $null }
    if (-not ($OldProcess -and $OldHealth -and $OldHealth.ready)) {
        throw 'The current bridge is not healthy. Use start.ps1 for recovery before a blue-green restart.'
    }
    if (-not (Test-BridgeIdle $OldHealth)) { throw 'BRIDGE_BUSY: waiting for turns, queued messages, approvals, archives and requests to finish.' }
    $HasGate = [bool]$OldHealth.PSObject.Properties['deployment']
    if (-not $HasGate -and -not $AllowLegacySource) { throw 'Source bridge needs a one-time -AllowLegacySource deployment before automatic updates.' }
    if (-not $HasGate -and $OldHealth.eventClients -gt 0) { throw 'BRIDGE_BUSY: close mobile bridge tabs for the one-time legacy migration.' }

    $CandidatePort = Select-CandidatePort $Config.LocalPort $CandidatePort
    if (-not $PSCmdlet.ShouldProcess("127.0.0.1:$($Config.LocalPort) -> 127.0.0.1:$CandidatePort", 'Start, verify, and switch the bridge')) { return }

    New-Item -ItemType Directory -Path $Config.StateDir, $Config.LogDir -Force | Out-Null
    $LeasePath = Join-Path $Config.StateDir 'deployment-lease.json'
    Write-BridgeDeploymentLease $LeasePath
    # Requests admitted before the lease must settle before a second process reads state.
    Start-Sleep -Milliseconds 300
    $OldHealth = Get-BridgeHealth $Config 5
    if (-not (Test-BridgeIdle $OldHealth)) { throw 'BRIDGE_BUSY: source became busy before draining.' }
    if ($HasGate -and -not $OldHealth.deployment.draining) { throw 'Source did not acknowledge the deployment lease.' }
    $CandidateOut = Join-Path $Config.LogDir "candidate-$CandidatePort.out.log"
    $CandidateErr = Join-Path $Config.LogDir "candidate-$CandidatePort.err.log"
    Rotate-BridgeLog $CandidateOut 3
    Rotate-BridgeLog $CandidateErr 3

    foreach ($Name in $EnvironmentNames) { $OriginalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
    [Environment]::SetEnvironmentVariable('BRIDGE_HOST', '127.0.0.1', 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_PORT', [string]$CandidatePort, 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_UI_LANGUAGE', $Config.UiLanguage, 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_STATE_FILE', (Join-Path $Config.StateDir 'bridge-state.json'), 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_COMMAND', $CodexCommand, 'Process')
    try {
        $CandidateProcess = Start-Process -FilePath $Config.NodePath `
            -ArgumentList ('"{0}"' -f $Config.ServerPath) `
            -WorkingDirectory $Config.Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $CandidateOut `
            -RedirectStandardError $CandidateErr `
            -PassThru
    } finally {
        foreach ($Name in $EnvironmentNames) {
            [Environment]::SetEnvironmentVariable($Name, $OriginalEnvironment[$Name], 'Process')
        }
    }

    $Deadline = (Get-Date).AddSeconds(60)
    $CandidateHealth = $null
    do {
        Start-Sleep -Milliseconds 400
        if ($CandidateProcess.HasExited) { throw "Candidate bridge exited with code $($CandidateProcess.ExitCode)." }
        $CandidateHealth = Get-CandidateHealth $CandidatePort 2
    } while ((-not ($CandidateHealth -and $CandidateHealth.ready)) -and (Get-Date) -lt $Deadline)
    if (-not ($CandidateHealth -and $CandidateHealth.ready)) {
        throw "Candidate bridge did not become ready. Check $CandidateErr"
    }

    Test-CandidateApi $CandidatePort
    $FinalOldHealth = Get-BridgeHealth $Config 5
    if (-not (Test-BridgeIdle $FinalOldHealth)) { throw 'BRIDGE_BUSY: source became busy before switching.' }
    if (-not $HasGate -and $FinalOldHealth.eventClients -gt 0) { throw 'BRIDGE_BUSY: a mobile client connected during legacy migration.' }
    $CandidateHealth = Get-CandidateHealth $CandidatePort
    if (-not $CandidateHealth.deployment.blocked) { throw 'Candidate must remain in standby until committed.' }
    $TailnetStatus = & $Config.TailscalePath status --json | ConvertFrom-Json
    $RemoteUrl = "https://$($TailnetStatus.Self.DNSName.TrimEnd('.')):$($Config.HttpsPort)/"
    $OriginalConfig = [IO.File]::ReadAllText($Config.ConfigPath)
    $CutoverState.RetainCandidate = $true
    Invoke-BridgeCutover -SwitchTraffic {
        Set-ServeTarget $Config $CandidatePort
    } -CommitConfig {
        Update-BridgeLocalConfig @{ localPort = $CandidatePort; remoteUrl = $RemoteUrl; codexCommand = $CodexCommand; previousCodexCommand = $Config.CodexCommand } | Out-Null
        Set-Content -LiteralPath $Config.PidPath -Value $CandidateProcess.Id -Encoding ascii
    } -Verify {
        # Writes stay frozen through the post-switch check, so rollback cannot
        # lose messages accepted only by the candidate.
        1..3 | ForEach-Object {
            Start-Sleep -Seconds 1
            $Verified = Get-CandidateHealth $CandidatePort
            if (-not $Verified -or -not $Verified.ready -or $Verified.deployment.standby -or -not $Verified.deployment.draining) { throw 'Post-switch readiness failed.' }
        }
        # Resolve the advertised tailnet IP explicitly: local DNS/proxy software
        # can rewrite *.ts.net, even while other tailnet devices can reach Serve.
        # curl still verifies the HTTPS certificate against the original hostname.
        $TailnetIp = @($TailnetStatus.Self.TailscaleIPs | Where-Object { $_ -notlike '*:*' })[0]
        if (-not $TailnetIp) { throw 'No tailnet IPv4 address is available for the HTTPS probe.' }
        $Curl = Resolve-BridgeExecutable -CommandNames @('curl.exe') -FallbackPaths @((Join-Path $env:SystemRoot 'System32\curl.exe'))
        if (-not $Curl) { throw 'curl.exe is required for the HTTPS route probe.' }
        $ProbeHost = $TailnetStatus.Self.DNSName.TrimEnd('.')
        $RemoteJson = & $Curl --fail --silent --show-error --noproxy '*' --max-time 10 --resolve "${ProbeHost}:$($Config.HttpsPort):${TailnetIp}" ($RemoteUrl + 'api/health')
        if ($LASTEXITCODE -ne 0) { throw 'HTTPS route probe failed.' }
        $RemoteHealth = ($RemoteJson -join "`n") | ConvertFrom-Json
        if ($RemoteHealth.eventStream.instanceId -ne $Verified.eventStream.instanceId) { throw 'HTTPS route is not serving the candidate.' }
    } -StopOld {
        Stop-OwnedProcess $OldProcess
    } -Rollback {
        # Restore routing before unfreezing either writer.
        Set-ServeTarget $Config $Config.LocalPort
        $TemporaryConfig = "$($Config.ConfigPath).$PID.tmp"
        [IO.File]::WriteAllText($TemporaryConfig, $OriginalConfig)
        Move-Item -LiteralPath $TemporaryConfig -Destination $Config.ConfigPath -Force
        Set-Content -LiteralPath $Config.PidPath -Value (Get-ProcessId $OldProcess) -Encoding ascii
    } -StopCandidate {
        Stop-OwnedProcess $CandidateProcess
        $CutoverState.RetainCandidate = $false
    }
    $Switched = $true
    $CutoverState.RetainCandidate = $false
    Write-Host "Blue-green restart completed: $($Config.LocalPort) -> $CandidatePort"
    Write-Host "Candidate PID: $($CandidateProcess.Id)"
    Write-Host "URL: $RemoteUrl"
} catch {
    if (-not $Switched -and -not $CutoverState.RetainCandidate) { Stop-OwnedProcess $CandidateProcess }
    throw
} finally {
    if ($LeasePath -and -not $CutoverState.RetainCandidate) { Remove-Item -LiteralPath $LeasePath -Force -ErrorAction SilentlyContinue }
    foreach ($Name in $EnvironmentNames) {
        if ($OriginalEnvironment.ContainsKey($Name)) {
            [Environment]::SetEnvironmentVariable($Name, $OriginalEnvironment[$Name], 'Process')
        }
    }
    Exit-BridgeLifecycleLock $LifecycleLock
}
