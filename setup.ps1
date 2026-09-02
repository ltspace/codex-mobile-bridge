[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(0, 65535)]
    [int]$LocalPort = 0,

    [ValidateRange(0, 65535)]
    [int]$HttpsPort = 0,

    [ValidateSet('auto', 'en', 'zh-CN')]
    [string]$Language = 'auto',

    [switch]$SkipWatchdog
)

$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
. (Join-Path $PSScriptRoot 'bridge-common.ps1')

if ($env:OS -ne 'Windows_NT') { throw 'setup.ps1 currently supports Windows only.' }

function Get-RequiredExecutable {
    param(
        [string]$Name,
        [string]$Preferred,
        [string[]]$Commands,
        [string[]]$FallbackPaths = @()
    )
    $Path = Resolve-BridgeExecutable -Preferred $Preferred -CommandNames $Commands -FallbackPaths $FallbackPaths
    if (-not $Path) { throw "$Name was not found. Install it, open a new PowerShell session, and run setup.ps1 again." }
    return $Path
}

function Test-BridgePortOwner([int]$Port, [string]$NodePath) {
    $Listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Listener) { return $true }
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $Process -or -not $Process.CommandLine) { return $false }
    try { $Executable = [IO.Path]::GetFullPath($Process.ExecutablePath) } catch { return $false }
    return $Executable -eq $NodePath -and $Process.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))
}

function Select-BridgeLocalPort([int]$Requested, [object]$Existing, [string]$NodePath) {
    $Candidates = if ($Requested) {
        @($Requested)
    } else {
        @((Get-BridgeConfigValue $Existing 'localPort'), 8765) + @(8766..8799)
    }
    foreach ($Candidate in $Candidates | Where-Object { $_ } | Select-Object -Unique) {
        $Port = ConvertTo-BridgePort $Candidate 8765 'Local port'
        if (Test-BridgePortOwner $Port $NodePath) { return $Port }
        if ($Requested) { throw "Local port $Port is already in use by another process." }
    }
    throw 'No available local port was found in the range 8765-8799.'
}

function Get-TailscaleServeSnapshot([string]$TailscalePath) {
    try {
        $Raw = (& $TailscalePath serve status --json 2>$null) -join "`n"
        if ($LASTEXITCODE -eq 0 -and $Raw) { return $Raw | ConvertFrom-Json }
    } catch {}
    return $null
}

function Test-ServePortOwned([object]$Snapshot, [int]$Port, [int]$LocalPort, [object]$Existing) {
    if (-not $Snapshot -or -not $Snapshot.TCP -or -not $Snapshot.TCP.PSObject.Properties[[string]$Port]) { return $true }
    if ((Get-BridgeConfigValue $Existing 'httpsPort') -eq $Port) { return $true }
    $ExpectedProxy = "http://127.0.0.1:$LocalPort"
    if ($Snapshot.Web) {
        foreach ($Site in $Snapshot.Web.PSObject.Properties) {
            if ($Site.Name -match ":$Port$" -and $Site.Value.Handlers -and $Site.Value.Handlers.PSObject.Properties['/']) {
                if ($Site.Value.Handlers.'/'.Proxy -eq $ExpectedProxy) { return $true }
            }
        }
    }
    return $false
}

function Select-BridgeHttpsPort([int]$Requested, [object]$Existing, [object]$ServeSnapshot, [int]$LocalPort) {
    $Candidates = if ($Requested) {
        @($Requested)
    } else {
        @((Get-BridgeConfigValue $Existing 'httpsPort'), 8443) + @(8444..8477)
    }
    foreach ($Candidate in $Candidates | Where-Object { $_ } | Select-Object -Unique) {
        $Port = ConvertTo-BridgePort $Candidate 8443 'HTTPS port'
        if (Test-ServePortOwned $ServeSnapshot $Port $LocalPort $Existing) { return $Port }
        if ($Requested) { throw "Tailscale Serve HTTPS port $Port is already assigned to another service." }
    }
    throw 'No available Tailscale Serve HTTPS port was found in the range 8443-8477.'
}

$Existing = Read-BridgeLocalConfig
$DefaultTailscale = if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' } else { $null }
$DefaultCodex = if ($env:APPDATA) { Join-Path $env:APPDATA 'npm\codex.cmd' } else { $null }
$NodePreferred = if ($env:BRIDGE_NODE_PATH) { $env:BRIDGE_NODE_PATH } else { Get-BridgeConfigValue $Existing 'nodePath' }
$TailscalePreferred = if ($env:BRIDGE_TAILSCALE_PATH) { $env:BRIDGE_TAILSCALE_PATH } else { Get-BridgeConfigValue $Existing 'tailscalePath' }
$CodexPreferred = if ($env:BRIDGE_CODEX_COMMAND) { $env:BRIDGE_CODEX_COMMAND } else { Get-BridgeConfigValue $Existing 'codexCommand' }

$NodePath = Get-RequiredExecutable 'Node.js' $NodePreferred @('node.exe', 'node')
$TailscalePath = Get-RequiredExecutable 'Tailscale' $TailscalePreferred @('tailscale.exe', 'tailscale') @($DefaultTailscale)
$CodexCommand = Get-RequiredExecutable 'Codex CLI' $CodexPreferred @('codex.cmd', 'codex') @($DefaultCodex)

$NodeVersionText = (& $NodePath --version 2>&1 | Select-Object -First 1).ToString().Trim()
if ($LASTEXITCODE -ne 0 -or $NodeVersionText -notmatch '^v(?<major>\d+)\.') { throw 'Unable to determine the Node.js version.' }
if ([int]$Matches.major -lt 20) { throw "Node.js 20 or newer is required; found $NodeVersionText." }
$CodexVersion = (& $CodexCommand --version 2>&1 | Select-Object -First 1).ToString().Trim()
if ($LASTEXITCODE -ne 0) { throw 'Codex CLI is installed but could not be started.' }
$TailscaleVersion = (& $TailscalePath version 2>&1 | Select-Object -First 1).ToString().Trim()
if ($LASTEXITCODE -ne 0) { throw 'Tailscale is installed but could not be started.' }
$TailnetStatus = (& $TailscalePath status --json 2>&1) -join "`n" | ConvertFrom-Json
$BackendState = Get-BridgeConfigValue $TailnetStatus 'BackendState'
if ($BackendState -and $BackendState -ne 'Running') {
    throw "Tailscale is not connected (state: $BackendState)."
}

$SelectedLocalPort = Select-BridgeLocalPort $LocalPort $Existing $NodePath
$ServeSnapshot = Get-TailscaleServeSnapshot $TailscalePath
$SelectedHttpsPort = Select-BridgeHttpsPort $HttpsPort $Existing $ServeSnapshot $SelectedLocalPort
$SelectedLanguage = if ($Language -eq 'auto') {
    if ((Get-BridgeConfigValue $Existing 'uiLanguage') -in @('en', 'zh-CN')) {
        Get-BridgeConfigValue $Existing 'uiLanguage'
    } elseif ([Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*') {
        'zh-CN'
    } else {
        'en'
    }
} else { $Language }

Write-Host 'Dependency check passed:'
Write-Host "  Node.js:   $NodeVersionText ($NodePath)"
Write-Host "  Codex CLI: $CodexVersion ($CodexCommand)"
Write-Host "  Tailscale: $TailscaleVersion ($TailscalePath)"
Write-Host 'Selected configuration:'
Write-Host "  Local HTTP:  127.0.0.1:$SelectedLocalPort"
Write-Host "  Tailnet HTTPS port: $SelectedHttpsPort"
Write-Host "  UI language: $SelectedLanguage"

if (-not $PSCmdlet.ShouldProcess($PSScriptRoot, 'Write local configuration, start Tailscale Serve, and install the watchdog')) { return }

$ConfigPath = Update-BridgeLocalConfig @{
    nodePath = $NodePath
    codexCommand = $CodexCommand
    tailscalePath = $TailscalePath
    localPort = $SelectedLocalPort
    httpsPort = $SelectedHttpsPort
    uiLanguage = $SelectedLanguage
    remoteUrl = $null
}

& (Join-Path $PSScriptRoot 'restart.ps1')
$PreviousHttpsPort = Get-BridgeConfigValue $Existing 'httpsPort'
if ($PreviousHttpsPort -and [int]$PreviousHttpsPort -ne $SelectedHttpsPort) {
    & $TailscalePath serve --https=([int]$PreviousHttpsPort) off 2>$null
    if ($LASTEXITCODE -notin @(0, 1)) { Write-Warning "The previous Tailscale Serve port $PreviousHttpsPort could not be disabled." }
}
if (-not $SkipWatchdog) {
    & (Join-Path $PSScriptRoot 'install-watchdog.ps1')
}

Write-Host "Setup complete. Local configuration: $ConfigPath"
& (Join-Path $PSScriptRoot 'status.ps1')
