[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$')]
    [string]$ThreadId,

    [Parameter(Mandatory = $true)]
    [string]$RolloutPath,

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
if (-not (Test-Path -LiteralPath $ResolvedRollout -PathType Leaf)) {
    throw "Rollout does not exist: $ResolvedRollout"
}
if (-not ([IO.Path]::GetFileName($ResolvedRollout).Contains($ThreadId))) {
    throw 'The rollout filename does not match the requested thread ID.'
}

$LockPath = Join-Path ([IO.Path]::GetFullPath($CodexHome)) "thread-writer-locks\$ThreadId.lock"
if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
    $ProbeScript = Join-Path $PSScriptRoot 'src\find-thread-writer.ps1'
    $Probe = (& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ProbeScript -LockPath $LockPath) | ConvertFrom-Json
    if (@($Probe.owners).Count -gt 0) {
        throw "Thread $ThreadId still has an active writer; repair was refused."
    }
}

$Utf8NoBom = [Text.UTF8Encoding]::new($false)
$RawText = [IO.File]::ReadAllText($ResolvedRollout, $Utf8NoBom)
$CrLfCount = [regex]::Matches($RawText, "`r`n").Count
$LfOnlyCount = [regex]::Matches($RawText, "(?<!`r)`n").Count
if ($CrLfCount -gt 0 -and $LfOnlyCount -gt 0) { throw 'Mixed rollout line endings were refused.' }
$LineEnding = if ($CrLfCount -gt 0) { "`r`n" } else { "`n" }
$HasTrailingLineEnding = $RawText.EndsWith($LineEnding, [StringComparison]::Ordinal)
$Lines = [IO.File]::ReadAllLines($ResolvedRollout, $Utf8NoBom)
if ($Lines.Count -lt 2) { throw 'The rollout is too short to repair.' }

$Ordinals = [Collections.Generic.List[long]]::new()
foreach ($Line in $Lines) {
    $Match = [regex]::Match($Line, '^\{"timestamp":"[^"]+","ordinal":(?<ordinal>\d+),')
    if (-not $Match.Success) { throw 'A rollout record is missing its top-level ordinal.' }
    $Ordinals.Add([long]$Match.Groups['ordinal'].Value)
}

$DuplicateIndex = -1
for ($Index = 1; $Index -lt $Ordinals.Count; $Index += 1) {
    if ($Ordinals[$Index] -eq ($Ordinals[$Index - 1] + 1)) { continue }
    if ($DuplicateIndex -lt 0 -and $Ordinals[$Index] -eq $Ordinals[$Index - 1]) {
        $DuplicateIndex = $Index
        continue
    }
    throw "Unsafe ordinal sequence at record ${Index}: $($Ordinals[$Index - 1]) -> $($Ordinals[$Index])."
}
if ($DuplicateIndex -lt 0) { throw 'No single duplicate ordinal was found; nothing was changed.' }

$Repaired = [string[]]::new($Lines.Count)
for ($Index = 0; $Index -lt $Lines.Count; $Index += 1) {
    if ($Index -lt $DuplicateIndex) {
        $Repaired[$Index] = $Lines[$Index]
        continue
    }
    $NewOrdinal = $Ordinals[$Index] + 1
    $Repaired[$Index] = [regex]::Replace(
        $Lines[$Index],
        '^(\{"timestamp":"[^"]+","ordinal":)\d+(,)',
        "`${1}$NewOrdinal`${2}",
        1
    )
}

for ($Index = 1; $Index -lt $Repaired.Count; $Index += 1) {
    $Previous = [long]([regex]::Match($Repaired[$Index - 1], '"ordinal":(?<ordinal>\d+)').Groups['ordinal'].Value)
    $Current = [long]([regex]::Match($Repaired[$Index], '"ordinal":(?<ordinal>\d+)').Groups['ordinal'].Value)
    if ($Current -ne ($Previous + 1)) { throw "Repaired validation failed at record $Index." }
}

$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$BackupDirectory = Join-Path ([IO.Path]::GetFullPath($BackupRoot)) "$Stamp-$ThreadId"
$BackupPath = Join-Path $BackupDirectory ([IO.Path]::GetFileName($ResolvedRollout))
$TemporaryPath = "$ResolvedRollout.$PID.repair.tmp"

if (-not $PSCmdlet.ShouldProcess($ResolvedRollout, "Back up and repair duplicate rollout ordinal at record $DuplicateIndex")) { return }

New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
Copy-Item -LiteralPath $ResolvedRollout -Destination $BackupPath -ErrorAction Stop
$OriginalHash = Get-Sha256Hex -Path $ResolvedRollout
$BackupHash = Get-Sha256Hex -Path $BackupPath
if ($OriginalHash -ne $BackupHash) { throw 'Backup hash does not match the original rollout.' }

try {
    $RepairedText = [string]::Join($LineEnding, $Repaired)
    if ($HasTrailingLineEnding) { $RepairedText += $LineEnding }
    [IO.File]::WriteAllText($TemporaryPath, $RepairedText, $Utf8NoBom)
    $TemporaryLines = [IO.File]::ReadAllLines($TemporaryPath, $Utf8NoBom)
    if ($TemporaryLines.Count -ne $Lines.Count) { throw 'The repaired rollout line count changed.' }
    Move-Item -LiteralPath $TemporaryPath -Destination $ResolvedRollout -Force
} finally {
    Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    threadId = $ThreadId
    rolloutPath = $ResolvedRollout
    backupPath = $BackupPath
    originalSha256 = $OriginalHash
    repairedRecords = $Lines.Count - $DuplicateIndex
    duplicateRecordIndex = $DuplicateIndex
    oldFinalOrdinal = $Ordinals[$Ordinals.Count - 1]
    newFinalOrdinal = $Ordinals[$Ordinals.Count - 1] + 1
} | ConvertTo-Json -Depth 3
