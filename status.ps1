$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

$Config = Get-BridgeConfig
$Process = Get-BridgeProcess $Config
$Health = Get-BridgeHealth $Config
$Listener = Get-NetTCPConnection -LocalPort $Config.LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$ServeOutput = try { (& $Config.TailscalePath serve status 2>$null) -join "`n" } catch { '' }
$ServeReady = Test-BridgeServe $Config
$Task = Get-ScheduledTask -TaskName $Config.TaskName -ErrorAction SilentlyContinue
$TaskInfo = if ($Task) { Get-ScheduledTaskInfo -TaskName $Config.TaskName -ErrorAction SilentlyContinue } else { $null }
$Url = if ($Config.RemoteUrl) { $Config.RemoteUrl } elseif (Test-Path -LiteralPath $Config.UrlPath) { (Get-Content -LiteralPath $Config.UrlPath -Raw).Trim() } else { $null }
$HealthVersion = if ($Health -and $Health.PSObject.Properties['version']) { $Health.version } else { $null }
$AppServer = if ($Health -and $Health.PSObject.Properties['appServer']) { $Health.appServer } else { $null }
$PendingRequests = if ($Health -and $Health.PSObject.Properties['pendingRequests']) { $Health.pendingRequests } elseif ($Health -and $Health.PSObject.Properties['pendingApprovals']) { $Health.pendingApprovals } else { $null }
$ActiveTurns = if ($Health -and $Health.PSObject.Properties['activeTurns'] -and $Health.activeTurns) { @($Health.activeTurns.PSObject.Properties).Count } else { 0 }
$Metrics = if ($Health -and $Health.PSObject.Properties['metrics']) { $Health.metrics } else { $null }
$HttpMetrics = if ($Metrics -and $Metrics.PSObject.Properties['http']) { $Metrics.http } else { $null }
$RpcMetrics = if ($Metrics -and $Metrics.PSObject.Properties['rpc']) { $Metrics.rpc } else { $null }

[pscustomobject]@{
    Running = [bool]$Process
    Healthy = [bool]($Health -and $Health.ready)
    Version = $HealthVersion
    Config = $Config.ConfigPath
    BridgePid = if ($Process) { $Process.ProcessId } else { $null }
    AppServerPid = if ($AppServer) { $AppServer.pid } else { $null }
    AppServerState = if ($AppServer) { $AppServer.status } else { if ($Health) { 'legacy' } else { 'unreachable' } }
    Listener = if ($Listener) { "$($Listener.LocalAddress):$($Listener.LocalPort) PID=$($Listener.OwningProcess)" } else { 'missing' }
    TailscaleServe = if ($ServeReady) { 'configured' } else { 'missing' }
    Watchdog = if ($Task) { $Task.State } else { 'NotInstalled' }
    WatchdogNextRun = if ($TaskInfo) { $TaskInfo.NextRunTime } else { $null }
    WatchdogLastResult = if ($TaskInfo) { '{0} (0x{1:X8})' -f $TaskInfo.LastTaskResult, ($TaskInfo.LastTaskResult -band 0xffffffff) } else { $null }
    PendingRequests = $PendingRequests
    ActiveTurns = $ActiveTurns
    HttpRequests = if ($HttpMetrics) { $HttpMetrics.requestsTotal } else { $null }
    HttpErrors = if ($HttpMetrics) { $HttpMetrics.errorsTotal } else { $null }
    HttpAverageMs = if ($HttpMetrics) { $HttpMetrics.averageDurationMs } else { $null }
    RpcRequests = if ($RpcMetrics) { $RpcMetrics.requestsTotal } else { $null }
    RpcErrors = if ($RpcMetrics) { $RpcMetrics.errorsTotal } else { $null }
    RpcAverageMs = if ($RpcMetrics) { $RpcMetrics.averageDurationMs } else { $null }
    Url = $Url
    ServeDetail = $ServeOutput
} | Format-List
