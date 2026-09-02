Set-StrictMode -Version Latest

function Read-BridgeLocalConfig {
    $Path = Join-Path $PSScriptRoot 'state\config.json'
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
        throw "Local configuration is invalid: $Path ($($_.Exception.Message))"
    }
}

function Get-BridgeConfigValue([object]$Config, [string]$Name) {
    if ($Config -and $Config.PSObject.Properties[$Name]) { return $Config.$Name }
    return $null
}

function Resolve-BridgeExecutable {
    param(
        [string]$Preferred,
        [string[]]$CommandNames = @(),
        [string[]]$FallbackPaths = @()
    )

    foreach ($Candidate in @($Preferred) + $FallbackPaths) {
        if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
            return [IO.Path]::GetFullPath($Candidate)
        }
    }
    foreach ($Name in $CommandNames) {
        $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($Command) { return [IO.Path]::GetFullPath($Command.Source) }
    }
    return $null
}

function ConvertTo-BridgePort([object]$Value, [int]$Default, [string]$Name) {
    $Port = if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { $Default } else { [int]$Value }
    if ($Port -lt 1 -or $Port -gt 65535) { throw "$Name must be between 1 and 65535." }
    return $Port
}

function Update-BridgeLocalConfig([hashtable]$Changes) {
    $StateDir = Join-Path $PSScriptRoot 'state'
    $Path = Join-Path $StateDir 'config.json'
    $Existing = Read-BridgeLocalConfig
    $Values = [ordered]@{}
    if ($Existing) {
        foreach ($Property in $Existing.PSObject.Properties) { $Values[$Property.Name] = $Property.Value }
    }
    foreach ($Key in $Changes.Keys) { $Values[$Key] = $Changes[$Key] }
    if (-not $Values.Contains('schemaVersion')) { $Values['schemaVersion'] = 1 }
    if (-not $Values.Contains('createdAt')) { $Values['createdAt'] = (Get-Date).ToUniversalTime().ToString('o') }
    $Values['updatedAt'] = (Get-Date).ToUniversalTime().ToString('o')

    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $Temporary = "$Path.$PID.tmp"
    $Values | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Temporary -Encoding utf8
    Move-Item -LiteralPath $Temporary -Destination $Path -Force
    return $Path
}

function Get-BridgeConfig {
    $BridgeRoot = $PSScriptRoot
    $Local = Read-BridgeLocalConfig
    $DefaultTailscale = if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' } else { $null }
    $DefaultCodex = if ($env:APPDATA) { Join-Path $env:APPDATA 'npm\codex.cmd' } else { $null }
    $NodePreferred = if ($env:BRIDGE_NODE_PATH) { $env:BRIDGE_NODE_PATH } else { Get-BridgeConfigValue $Local 'nodePath' }
    $TailscalePreferred = if ($env:BRIDGE_TAILSCALE_PATH) { $env:BRIDGE_TAILSCALE_PATH } else { Get-BridgeConfigValue $Local 'tailscalePath' }
    $CodexPreferred = if ($env:BRIDGE_CODEX_COMMAND) { $env:BRIDGE_CODEX_COMMAND } else { Get-BridgeConfigValue $Local 'codexCommand' }
    $NodePath = Resolve-BridgeExecutable -Preferred $NodePreferred -CommandNames @('node.exe', 'node')
    $TailscalePath = Resolve-BridgeExecutable -Preferred $TailscalePreferred -CommandNames @('tailscale.exe', 'tailscale') -FallbackPaths @($DefaultTailscale)
    $CodexCommand = Resolve-BridgeExecutable -Preferred $CodexPreferred -CommandNames @('codex.cmd', 'codex') -FallbackPaths @($DefaultCodex)

    foreach ($Dependency in @(
        @{ Name = 'Node.js'; Path = $NodePath },
        @{ Name = 'Codex CLI'; Path = $CodexCommand },
        @{ Name = 'Tailscale'; Path = $TailscalePath },
        @{ Name = 'server.mjs'; Path = (Join-Path $BridgeRoot 'server.mjs') }
    )) {
        if (-not $Dependency.Path -or -not (Test-Path -LiteralPath $Dependency.Path -PathType Leaf)) {
            throw "$($Dependency.Name) was not found. Run .\setup.ps1 after installing the dependency."
        }
    }

    $LocalPortValue = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { Get-BridgeConfigValue $Local 'localPort' }
    $HttpsPortValue = if ($env:BRIDGE_HTTPS_PORT) { $env:BRIDGE_HTTPS_PORT } else { Get-BridgeConfigValue $Local 'httpsPort' }
    $UiLanguage = if ($env:BRIDGE_UI_LANGUAGE) { $env:BRIDGE_UI_LANGUAGE } else { Get-BridgeConfigValue $Local 'uiLanguage' }
    if ($UiLanguage -notin @('en', 'zh-CN')) { $UiLanguage = if ([Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*') { 'zh-CN' } else { 'en' } }

    [pscustomobject]@{
        Root = $BridgeRoot
        StateDir = Join-Path $BridgeRoot 'state'
        LogDir = Join-Path $BridgeRoot 'logs'
        ConfigPath = Join-Path $BridgeRoot 'state\config.json'
        PidPath = Join-Path $BridgeRoot 'state\server.pid'
        UrlPath = Join-Path $BridgeRoot 'state\url.txt'
        ServerPath = Join-Path $BridgeRoot 'server.mjs'
        NodePath = $NodePath
        TailscalePath = $TailscalePath
        CodexCommand = $CodexCommand
        LocalPort = ConvertTo-BridgePort $LocalPortValue 8765 'Local port'
        HttpsPort = ConvertTo-BridgePort $HttpsPortValue 8443 'HTTPS port'
        UiLanguage = $UiLanguage
        RemoteUrl = Get-BridgeConfigValue $Local 'remoteUrl'
        TaskName = 'Codex Mobile Bridge Watchdog'
    }
}

function Get-BridgeProcess([object]$Config) {
    $Candidates = @()
    $Listener = Get-NetTCPConnection -LocalPort $Config.LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Listener) {
        $ByListener = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($ByListener) { $Candidates += $ByListener }
    }
    if (Test-Path -LiteralPath $Config.PidPath) {
        $RawPid = (Get-Content -LiteralPath $Config.PidPath -Raw -ErrorAction SilentlyContinue).Trim()
        if ($RawPid -match '^\d+$') {
            $ByPid = Get-CimInstance Win32_Process -Filter "ProcessId=$RawPid" -ErrorAction SilentlyContinue
            if ($ByPid) { $Candidates += $ByPid }
        }
    }
    $Candidates += Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Config.ServerPath) }

    $Seen = @{}
    foreach ($Process in $Candidates) {
        if ($Seen.ContainsKey([string]$Process.ProcessId)) { continue }
        $Seen[[string]$Process.ProcessId] = $true
        try {
            $Executable = [IO.Path]::GetFullPath($Process.ExecutablePath)
            if ($Executable -eq $Config.NodePath -and $Process.CommandLine.Contains($Config.ServerPath)) { return $Process }
        } catch {}
    }
    return $null
}

function Get-BridgeHealth([object]$Config, [int]$TimeoutSeconds = 3) {
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.LocalPort)/api/health" -TimeoutSec $TimeoutSeconds
    } catch {
        return $null
    }
}

function Test-BridgeServe([object]$Config) {
    try {
        $Raw = (& $Config.TailscalePath serve status --json 2>$null) -join "`n"
        if ($LASTEXITCODE -eq 0 -and $Raw) {
            $Snapshot = $Raw | ConvertFrom-Json
            $Tcp = $Snapshot.TCP.PSObject.Properties[[string]$Config.HttpsPort]
            if (-not $Tcp -or -not $Tcp.Value.HTTPS) { return $false }
            $ExpectedProxy = "http://127.0.0.1:$($Config.LocalPort)"
            foreach ($Site in $Snapshot.Web.PSObject.Properties) {
                if ($Site.Name -match ":$($Config.HttpsPort)$" -and $Site.Value.Handlers.PSObject.Properties['/']) {
                    return $Site.Value.Handlers.'/'.Proxy -eq $ExpectedProxy
                }
            }
            return $false
        }
    } catch {}
    try {
        $Serve = (& $Config.TailscalePath serve status 2>$null) -join "`n"
        return $Serve.Contains(":$($Config.HttpsPort)") -and $Serve.Contains("127.0.0.1:$($Config.LocalPort)")
    } catch { return $false }
}

function Rotate-BridgeLog([string]$Path, [int]$Keep = 3) {
    for ($Index = $Keep; $Index -ge 1; $Index--) {
        $Source = if ($Index -eq 1) { $Path } else { "$Path.$($Index - 1)" }
        $Target = "$Path.$Index"
        if (Test-Path -LiteralPath $Source) { Move-Item -LiteralPath $Source -Destination $Target -Force }
    }
}

function Enter-BridgeLifecycleLock([int]$TimeoutMilliseconds = 30000) {
    $Mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileBridgeLifecycle')
    try {
        if (-not $Mutex.WaitOne($TimeoutMilliseconds)) {
            $Mutex.Dispose()
            throw 'Timed out waiting for another bridge lifecycle operation.'
        }
    } catch [Threading.AbandonedMutexException] {
        # The prior owner exited unexpectedly; this caller now owns the mutex.
    }
    return $Mutex
}

function Exit-BridgeLifecycleLock([Threading.Mutex]$Mutex) {
    try { $Mutex.ReleaseMutex() } catch {}
    $Mutex.Dispose()
}
