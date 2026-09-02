[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(0, 65535)]
    [int]$CandidatePort = 0,

    [switch]$AllowActiveTurn
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

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
    $Threads = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/threads?limit=10" -TimeoutSec 30
    $Items = @($Threads.data)
    if ($Items.Count -gt 0 -and $Items[0].id) {
        # App Server can report an externally owned writer as notLoaded. Avoid a
        # history probe that may block on that writer while still validating the
        # App Server list path and the bridge-local queue contract.
        $ThreadId = [uri]::EscapeDataString([string]$Items[0].id)
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/threads/$ThreadId/queue" -TimeoutSec 5 | Out-Null
    }
}

function Set-ServeTarget([object]$Config, [int]$LocalPort) {
    & $Config.TailscalePath serve --bg --yes --https=$($Config.HttpsPort) "http://127.0.0.1:$LocalPort" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to point Tailscale Serve at port $LocalPort." }
    $Serve = (& $Config.TailscalePath serve status 2>$null) -join "`n"
    if (-not ($Serve.Contains(":$($Config.HttpsPort)") -and $Serve.Contains("127.0.0.1:$LocalPort"))) {
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
$OriginalEnvironment = @{}
$EnvironmentNames = @('BRIDGE_HOST', 'BRIDGE_PORT', 'BRIDGE_UI_LANGUAGE', 'BRIDGE_STATE_FILE', 'CODEX_COMMAND')

try {
    $Config = Get-BridgeConfig
    $OldProcess = Get-BridgeProcess $Config
    $OldHealth = if ($OldProcess) { Get-BridgeHealth $Config 5 } else { $null }
    if (-not ($OldProcess -and $OldHealth -and $OldHealth.ready)) {
        throw 'The current bridge is not healthy. Use start.ps1 for recovery before a blue-green restart.'
    }
    $ActiveTurns = if ($OldHealth.activeTurns) { @($OldHealth.activeTurns.PSObject.Properties).Count } else { 0 }
    if ($ActiveTurns -gt 0 -and -not $AllowActiveTurn) {
        throw "Blue-green restart refused because $ActiveTurns turn(s) are active. Wait for idle or pass -AllowActiveTurn explicitly."
    }

    $CandidatePort = Select-CandidatePort $Config.LocalPort $CandidatePort
    if (-not $PSCmdlet.ShouldProcess("127.0.0.1:$($Config.LocalPort) -> 127.0.0.1:$CandidatePort", 'Start, verify, and switch the bridge')) { return }

    New-Item -ItemType Directory -Path $Config.StateDir, $Config.LogDir -Force | Out-Null
    $CandidateOut = Join-Path $Config.LogDir "candidate-$CandidatePort.out.log"
    $CandidateErr = Join-Path $Config.LogDir "candidate-$CandidatePort.err.log"
    Rotate-BridgeLog $CandidateOut 3
    Rotate-BridgeLog $CandidateErr 3

    foreach ($Name in $EnvironmentNames) { $OriginalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
    [Environment]::SetEnvironmentVariable('BRIDGE_HOST', '127.0.0.1', 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_PORT', [string]$CandidatePort, 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_UI_LANGUAGE', $Config.UiLanguage, 'Process')
    [Environment]::SetEnvironmentVariable('BRIDGE_STATE_FILE', (Join-Path $Config.StateDir 'bridge-state.json'), 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_COMMAND', $Config.CodexCommand, 'Process')
    try {
        $CandidateProcess = Start-Process -FilePath $Config.NodePath `
            -ArgumentList $Config.ServerPath `
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
    Set-ServeTarget $Config $CandidatePort
    $Switched = $true

    $TailnetStatus = & $Config.TailscalePath status --json | ConvertFrom-Json
    $RemoteUrl = "https://$($TailnetStatus.Self.DNSName.TrimEnd('.')):$($Config.HttpsPort)/"
    if (-not (Get-Command Update-BridgeLocalConfig -ErrorAction SilentlyContinue)) {
        throw 'Update-BridgeLocalConfig is unavailable; run the current setup.ps1 before blue-green deployment.'
    }
    Update-BridgeLocalConfig @{ localPort = $CandidatePort; remoteUrl = $RemoteUrl } | Out-Null
    Set-Content -LiteralPath $Config.PidPath -Value $CandidateProcess.Id -Encoding ascii

    Stop-OwnedProcess $OldProcess
    Write-Host "Blue-green restart completed: $($Config.LocalPort) -> $CandidatePort"
    Write-Host "Candidate PID: $($CandidateProcess.Id)"
    Write-Host "URL: $RemoteUrl"
} catch {
    $Failure = $_
    $OldProcessId = Get-ProcessId $OldProcess
    if ($Switched -and $OldProcessId -and (Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue)) {
        try {
            Set-ServeTarget $Config $Config.LocalPort
            if (Get-Command Update-BridgeLocalConfig -ErrorAction SilentlyContinue) {
                Update-BridgeLocalConfig @{ localPort = $Config.LocalPort } | Out-Null
            }
            Set-Content -LiteralPath $Config.PidPath -Value $OldProcessId -Encoding ascii
            $Switched = $false
        } catch {
            Write-Warning "Automatic rollback failed: $($_.Exception.Message)"
        }
    }
    if (-not $Switched) { Stop-OwnedProcess $CandidateProcess }
    throw $Failure
} finally {
    foreach ($Name in $EnvironmentNames) {
        if ($OriginalEnvironment.ContainsKey($Name)) {
            [Environment]::SetEnvironmentVariable($Name, $OriginalEnvironment[$Name], 'Process')
        }
    }
    Exit-BridgeLifecycleLock $LifecycleLock
}
