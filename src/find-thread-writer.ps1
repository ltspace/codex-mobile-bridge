[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$LockPath,

  [switch]$Terminate,

  [int]$ExpectedPid = 0,

  [string]$ExpectedStartedAt = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
  @{ owners = @(); terminated = $false } | ConvertTo-Json -Compress
  exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexBridgeRestartManager {
    private const int ErrorMoreData = 234;

    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
    }

    public enum ApplicationType {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string ApplicationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string ServiceName;
        public ApplicationType Type;
        public uint Status;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint handle, int flags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint handle,
        uint fileCount,
        string[] files,
        uint applicationCount,
        IntPtr applications,
        uint serviceCount,
        string[] services);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint handle,
        out uint needed,
        ref uint count,
        [In, Out] ProcessInfo[] processes,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint handle);

    public static ProcessInfo[] Find(string path) {
        return FindMany(new[] { path });
    }

    public static ProcessInfo[] FindMany(string[] paths) {
        if (paths.Length == 0) return new ProcessInfo[0];
        uint handle;
        var sessionKey = new StringBuilder(64);
        var result = RmStartSession(out handle, 0, sessionKey);
        if (result != 0) throw new InvalidOperationException("RmStartSession failed: " + result);

        try {
            result = RmRegisterResources(handle, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources failed: " + result);

            uint needed = 0;
            uint count = 0;
            uint rebootReasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref rebootReasons);
            if (result == 0) return new ProcessInfo[0];
            if (result != ErrorMoreData) throw new InvalidOperationException("RmGetList failed: " + result);

            var processes = new ProcessInfo[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, processes, ref rebootReasons);
            if (result != 0) throw new InvalidOperationException("RmGetList failed: " + result);
            if (count != processes.Length) Array.Resize(ref processes, (int)count);
            return processes;
        } finally {
            RmEndSession(handle);
        }
    }
}
'@

$LockPath = [IO.Path]::GetFullPath($LockPath)
$TargetThreadId = [IO.Path]::GetFileNameWithoutExtension($LockPath)
if ($TargetThreadId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$') { throw 'Invalid thread lock name' }
$TargetOwners = @([CodexBridgeRestartManager]::Find($LockPath))
if ($TargetOwners.Count -eq 0) {
  if ($Terminate) { throw 'Expected exactly one lock owner' }
  @{ owners = @(); terminated = $false } | ConvertTo-Json -Compress
  exit 0
}

# One batch answers the safety question: does this PID own ANY other thread?
# Do not include the shared .coordination.lock or claim an exact thread count.
$OtherLocks = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($LockPath)) -Filter '*.lock' -File -ErrorAction Stop |
  Where-Object { $_.FullName -ine $LockPath -and $_.BaseName -match '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' } |
  ForEach-Object { $_.FullName })
$OtherOwnerPids = @{}
foreach ($OtherOwner in @([CodexBridgeRestartManager]::FindMany([string[]]$OtherLocks))) {
  $OtherOwnerPids[[int]$OtherOwner.Process.ProcessId] = $true
}

# Fetch metadata once instead of a separate WMI query for every ancestor.
$ProcessById = @{}
foreach ($Entry in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
  $ProcessById[[int]$Entry.ProcessId] = $Entry
}

function Get-AncestorProcessIds {
  param([int]$StartingProcessId)

  $result = @()
  $seen = @{}
  $currentId = $StartingProcessId
  for ($depth = 0; $depth -lt 32 -and $currentId -gt 0; $depth += 1) {
    if ($seen.ContainsKey($currentId)) { break }
    $seen[$currentId] = $true
    $process = $ProcessById[$currentId]
    if (-not $process) { break }
    $parentId = [int]$process.ParentProcessId
    if ($parentId -le 0) { break }
    $result += $parentId
    $currentId = $parentId
  }
  return @($result)
}

$owners = @(
  $TargetOwners | ForEach-Object {
    $processId = [int]$_.Process.ProcessId
    $process = $ProcessById[$processId]
    if (-not $process) { throw 'Cannot inspect lock owner process; retry inspection' }
    if ($process) {
      [ordered]@{
        pid = $processId
        startedAt = $process.CreationDate.ToUniversalTime().ToString("o")
        executablePath = [string]$process.ExecutablePath
        commandLine = [string]$process.CommandLine
        parentPid = [int]$process.ParentProcessId
        ancestorPids = @(Get-AncestorProcessIds -StartingProcessId $processId)
        threadIds = @($TargetThreadId)
        sharedOwner = $OtherOwnerPids.ContainsKey($processId)
      }
    }
  }
)

$terminated = $false
if ($Terminate) {
  if ($owners.Count -ne 1) { throw "Expected exactly one lock owner" }
  $owner = $owners[0]
  if ($ExpectedPid -le 0 -or $owner.pid -ne $ExpectedPid) { throw "Lock owner PID changed" }
  if (-not $ExpectedStartedAt -or $owner.startedAt -ne $ExpectedStartedAt) { throw "Lock owner start time changed" }
  if ([IO.Path]::GetFileName($owner.executablePath) -ine "codex.exe") { throw "Lock owner is not codex.exe" }
  if ($owner.commandLine -notmatch "\bapp-server\b") { throw "Lock owner is not an app-server" }
  if ($owner.executablePath -notmatch "\\\.vscode(?:-insiders)?\\extensions\\openai\.chatgpt-[^\\]+\\") {
    throw "Lock owner is not a VS Code Codex extension process"
  }
  $targetThreadId = [IO.Path]::GetFileNameWithoutExtension($LockPath)
  $ownedThreadIds = @($owner.threadIds)
  if ($owner.sharedOwner -or $ownedThreadIds.Count -ne 1 -or $ownedThreadIds[0] -ne $targetThreadId) {
    throw "Writer owns multiple thread locks"
  }
  # Recheck identity after the OS lock queries, immediately before termination.
  $CurrentOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.pid)" -ErrorAction Stop
  if (-not $CurrentOwner -or $CurrentOwner.CreationDate.ToUniversalTime().ToString('o') -ne $ExpectedStartedAt) { throw 'Lock owner start time changed' }
  Stop-Process -Id $owner.pid -Force -ErrorAction Stop
  Wait-Process -Id $owner.pid -Timeout 5 -ErrorAction SilentlyContinue
  if (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) { throw "Lock owner did not exit" }
  $terminated = $true
}

@{ owners = $owners; terminated = $terminated } | ConvertTo-Json -Depth 5 -Compress
