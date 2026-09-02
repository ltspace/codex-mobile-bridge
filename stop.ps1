param(
    [switch]$KeepServe
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

$LifecycleLock = Enter-BridgeLifecycleLock
$Config = $null
try {
    $Config = Get-BridgeConfig
    if (-not $KeepServe) {
        & $Config.TailscalePath serve --https=$($Config.HttpsPort) off 2>$null
        if ($LASTEXITCODE -notin @(0, 1)) { throw 'Unable to disable Tailscale Serve.' }
    }

    $Process = Get-BridgeProcess $Config
    if ($Process) {
        Stop-Process -Id $Process.ProcessId -ErrorAction Stop
        $Deadline = (Get-Date).AddSeconds(8)
        while ((Get-Process -Id $Process.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $Deadline) {
            Start-Sleep -Milliseconds 200
        }
        if (Get-Process -Id $Process.ProcessId -ErrorAction SilentlyContinue) {
            Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
        }
        Write-Host "Stopped bridge PID $($Process.ProcessId)."
    }
    Remove-Item -LiteralPath $Config.PidPath -Force -ErrorAction SilentlyContinue
    Write-Host 'Codex Mobile Bridge stopped.'
} finally {
    Exit-BridgeLifecycleLock $LifecycleLock
}
