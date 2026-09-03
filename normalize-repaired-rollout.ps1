[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$')]
    [string]$ThreadId,

    [Parameter(Mandatory = $true)]
    [string]$RolloutPath,

    [Parameter(Mandatory = $true)]
    [ValidateRange(0, [long]::MaxValue)]
    [long]$ExpectedCursorOffset,

    [Parameter(Mandatory = $true)]
    [ValidateRange(0, [long]::MaxValue)]
    [long]$ExpectedCursorOrdinal,

    [string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'),

    [string]$BackupRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\session-repair-backups')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Stream = [IO.File]::OpenRead($Path)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '')
    } finally {
        $Hasher.Dispose()
        $Stream.Dispose()
    }
}

$ResolvedRollout = [IO.Path]::GetFullPath($RolloutPath)
if (-not (Test-Path -LiteralPath $ResolvedRollout -PathType Leaf)) { throw "Rollout does not exist: $ResolvedRollout" }
if (-not ([IO.Path]::GetFileName($ResolvedRollout).Contains($ThreadId))) { throw 'The rollout filename does not match the requested thread ID.' }

$LockPath = Join-Path ([IO.Path]::GetFullPath($CodexHome)) "thread-writer-locks\$ThreadId.lock"
if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
    $ProbeScript = Join-Path $PSScriptRoot 'src\find-thread-writer.ps1'
    $Probe = (& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ProbeScript -LockPath $LockPath) | ConvertFrom-Json
    if (@($Probe.owners).Count -gt 0) { throw "Thread $ThreadId still has an active writer; normalization was refused." }
}

$Utf8NoBom = [Text.UTF8Encoding]::new($false)
$RawText = [IO.File]::ReadAllText($ResolvedRollout, $Utf8NoBom)
$CrLfCount = [regex]::Matches($RawText, "`r`n").Count
$LfOnlyCount = [regex]::Matches($RawText, "(?<!`r)`n").Count
if ($CrLfCount -eq 0 -or $LfOnlyCount -ne 0) { throw 'Expected a rollout containing CRLF line endings only.' }
if (-not $RawText.EndsWith("`r`n", [StringComparison]::Ordinal)) { throw 'Expected a trailing CRLF line ending.' }

$Lines = [IO.File]::ReadAllLines($ResolvedRollout, $Utf8NoBom)
$Ordinals = [Collections.Generic.List[long]]::new()
foreach ($Line in $Lines) {
    $Match = [regex]::Match($Line, '^\{"timestamp":"[^"]+","ordinal":(?<ordinal>\d+),')
    if (-not $Match.Success) { throw 'A rollout record is missing its top-level ordinal.' }
    $Ordinals.Add([long]$Match.Groups['ordinal'].Value)
}
for ($Index = 1; $Index -lt $Ordinals.Count; $Index += 1) {
    if ($Ordinals[$Index] -ne ($Ordinals[$Index - 1] + 1)) {
        throw "Rollout ordinal sequence is not continuous at record ${Index}."
    }
}

$CursorIndex = $Ordinals.IndexOf($ExpectedCursorOrdinal)
if ($CursorIndex -lt 0) { throw "Expected cursor ordinal $ExpectedCursorOrdinal was not found." }
$CursorPrefix = if ($CursorIndex -eq 0) { '' } else { [string]::Join("`n", $Lines[0..($CursorIndex - 1)]) + "`n" }
$ComputedCursorOffset = $Utf8NoBom.GetByteCount($CursorPrefix)
if ($ComputedCursorOffset -ne $ExpectedCursorOffset) {
    throw "LF byte layout would place ordinal $ExpectedCursorOrdinal at $ComputedCursorOffset, not expected offset $ExpectedCursorOffset."
}

$NormalizedText = [string]::Join("`n", $Lines) + "`n"
$ExpectedLength = $Utf8NoBom.GetByteCount($NormalizedText)
if ($ExpectedLength -ne (([IO.FileInfo]$ResolvedRollout).Length - $CrLfCount)) {
    throw 'Normalized rollout byte length did not match the exact CR removal count.'
}

$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$BackupDirectory = Join-Path ([IO.Path]::GetFullPath($BackupRoot)) "$Stamp-$ThreadId-byte-layout"
$BackupPath = Join-Path $BackupDirectory ([IO.Path]::GetFileName($ResolvedRollout))
$TemporaryPath = "$ResolvedRollout.$PID.normalize.tmp"

if (-not $PSCmdlet.ShouldProcess($ResolvedRollout, 'Back up and restore the original LF byte layout')) { return }

New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
Copy-Item -LiteralPath $ResolvedRollout -Destination $BackupPath -ErrorAction Stop
$OriginalHash = Get-Sha256Hex -Path $ResolvedRollout
if ($OriginalHash -ne (Get-Sha256Hex -Path $BackupPath)) { throw 'Backup hash does not match the current rollout.' }

try {
    [IO.File]::WriteAllText($TemporaryPath, $NormalizedText, $Utf8NoBom)
    if (([IO.FileInfo]$TemporaryPath).Length -ne $ExpectedLength) { throw 'Temporary normalized rollout has the wrong byte length.' }
    Move-Item -LiteralPath $TemporaryPath -Destination $ResolvedRollout -Force
} finally {
    Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    threadId = $ThreadId
    rolloutPath = $ResolvedRollout
    backupPath = $BackupPath
    originalSha256 = $OriginalHash
    records = $Lines.Count
    finalOrdinal = $Ordinals[$Ordinals.Count - 1]
    removedCarriageReturns = $CrLfCount
    cursorOrdinal = $ExpectedCursorOrdinal
    cursorOffset = $ComputedCursorOffset
    normalizedBytes = $ExpectedLength
} | ConvertTo-Json -Depth 3
