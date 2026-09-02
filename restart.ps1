$ErrorActionPreference = 'Stop'

try {
    & (Join-Path $PSScriptRoot 'stop.ps1') -KeepServe
} finally {
    & (Join-Path $PSScriptRoot 'start.ps1')
}
