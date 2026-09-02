param(
    [switch]$SkipServe,
    [switch]$LifecycleLockHeld
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

$LifecycleLock = if ($LifecycleLockHeld) { $null } else { Enter-BridgeLifecycleLock }
$Config = $null
try {
    $Config = Get-BridgeConfig
    New-Item -ItemType Directory -Path $Config.StateDir, $Config.LogDir -Force | Out-Null
    & $Config.NodePath --check $Config.ServerPath
    if ($LASTEXITCODE -ne 0) { throw 'server.mjs syntax check failed.' }

    $Process = Get-BridgeProcess $Config
    $Health = if ($Process) { Get-BridgeHealth $Config } else { $null }
    if ($Process -and -not ($Health -and $Health.ready)) {
        Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
        Wait-Process -Id $Process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        $Process = $null
        $Health = $null
    }

    if (-not $Process) {
        $PortOwner = Get-NetTCPConnection -LocalPort $Config.LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($PortOwner) { throw "Port $($Config.LocalPort) is already owned by PID $($PortOwner.OwningProcess)." }
        Remove-Item -LiteralPath $Config.PidPath -Force -ErrorAction SilentlyContinue
        Rotate-BridgeLog (Join-Path $Config.LogDir 'server.out.log')
        Rotate-BridgeLog (Join-Path $Config.LogDir 'server.err.log')

        [Environment]::SetEnvironmentVariable('BRIDGE_HOST', '127.0.0.1', 'Process')
        [Environment]::SetEnvironmentVariable('BRIDGE_PORT', [string]$Config.LocalPort, 'Process')
        [Environment]::SetEnvironmentVariable('BRIDGE_UI_LANGUAGE', $Config.UiLanguage, 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_COMMAND', $Config.CodexCommand, 'Process')
        $Process = Start-Process -FilePath $Config.NodePath `
            -ArgumentList $Config.ServerPath `
            -WorkingDirectory $Config.Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $Config.LogDir 'server.out.log') `
            -RedirectStandardError (Join-Path $Config.LogDir 'server.err.log') `
            -PassThru
        Set-Content -LiteralPath $Config.PidPath -Value $Process.Id -Encoding ascii

        $Deadline = (Get-Date).AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 400
            if ($Process.HasExited) { throw "Bridge process exited with code $($Process.ExitCode)." }
            $Health = Get-BridgeHealth $Config 2
        } while ((-not ($Health -and $Health.ready)) -and (Get-Date) -lt $Deadline)

        if (-not ($Health -and $Health.ready)) {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $Config.PidPath -Force -ErrorAction SilentlyContinue
            throw "Bridge did not become ready. Check $($Config.LogDir)\server.err.log"
        }
    } else {
        Set-Content -LiteralPath $Config.PidPath -Value $Process.ProcessId -Encoding ascii
    }

    if (-not $SkipServe) {
        & $Config.TailscalePath serve --bg --yes --https=$($Config.HttpsPort) "http://127.0.0.1:$($Config.LocalPort)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve setup failed.' }
        $TailnetStatus = & $Config.TailscalePath status --json | ConvertFrom-Json
        $DnsName = $TailnetStatus.Self.DNSName.TrimEnd('.')
        $RemoteUrl = "https://${DnsName}:$($Config.HttpsPort)/"
        Set-Content -LiteralPath $Config.UrlPath -Value $RemoteUrl -Encoding utf8
        Update-BridgeLocalConfig @{ remoteUrl = $RemoteUrl } | Out-Null
    } else {
        $RemoteUrl = if ($Config.RemoteUrl) { $Config.RemoteUrl } elseif (Test-Path -LiteralPath $Config.UrlPath) { (Get-Content -LiteralPath $Config.UrlPath -Raw).Trim() } else { $null }
    }

    $HealthVersion = if ($Health -and $Health.PSObject.Properties['version']) { $Health.version } else { 'legacy' }
    $BridgePid = if ($Process.PSObject.Properties['ProcessId']) { $Process.ProcessId } else { $Process.Id }
    Write-Host "Codex Mobile Bridge v$HealthVersion is ready (PID $BridgePid):"
    if ($RemoteUrl) { Write-Host $RemoteUrl }
} finally {
    if ($LifecycleLock) { Exit-BridgeLifecycleLock $LifecycleLock }
}
