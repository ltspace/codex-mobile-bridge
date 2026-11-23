param(
    [Parameter(Mandatory)] [int] $DesktopProcessId,
    [Parameter(Mandatory)] [string] $ThreadId
)

$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$Request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$MaxFrameBytes = 8MB
$Script:RequestId = 0

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class BridgeDesktopPipe {
    [DllImport("kernel32.dll")]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll")]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static bool BelongsToDesktop(SafePipeHandle pipe, uint expectedPid) {
        uint actualPid;
        if (!GetNamedPipeServerProcessId(pipe, out actualPid) || actualPid != expectedPid) return false;
        IntPtr process = OpenProcess(0x1000, false, actualPid);
        if (process == IntPtr.Zero) return false;
        try {
            uint length = 256;
            var name = new StringBuilder((int)length);
            return GetPackageFamilyName(process, ref length, name) == 0 &&
                String.Equals(name.ToString(), "OpenAI.Codex_2p2nqsd0c76g0", StringComparison.OrdinalIgnoreCase);
        } finally {
            CloseHandle(process);
        }
    }
}
'@

function Invoke-DesktopRpc($Pipe, $Reader, [string] $Method, [hashtable] $Arguments) {
    $Id = ++$Script:RequestId
    $Payload = $Utf8.GetBytes((@{ id = $Id; jsonrpc = '2.0'; method = $Method; params = $Arguments } |
        ConvertTo-Json -Depth 12 -Compress))
    $Header = [BitConverter]::GetBytes([uint32] $Payload.Length)
    $Pipe.Write($Header, 0, $Header.Length)
    $Pipe.Write($Payload, 0, $Payload.Length)
    $Pipe.Flush()
    $Size = $Reader.ReadUInt32()
    if ($Size -eq 0 -or $Size -gt $MaxFrameBytes) { throw 'Invalid Desktop response size.' }
    $Bytes = $Reader.ReadBytes([int] $Size)
    if ($Bytes.Length -ne $Size) { throw 'Incomplete Desktop response.' }
    $Response = $Utf8.GetString($Bytes) | ConvertFrom-Json
    if ($Response.id -ne $Id) { throw 'Unexpected Desktop response ID.' }
    return $Response
}

function Invoke-DesktopTool($Pipe, $Reader, [string] $Tool, [hashtable] $Arguments) {
    $CallId = 'mobile-bridge-' + [Guid]::NewGuid().ToString('N')
    Invoke-DesktopRpc $Pipe $Reader 'tools/call' @{
        callerSource = 'codex'; namespace = 'codex_app'; tool = $Tool
        threadId = $ThreadId; turnId = $CallId; callId = $CallId; arguments = $Arguments
    }
}

function Get-DesktopToolResult($Response) {
    if ($Response.error -or $Response.result.success -ne $true) { return $null }
    $Item = $Response.result.contentItems | Where-Object type -eq 'inputText' | Select-Object -First 1
    if ($Item.text) { return $Item.text | ConvertFrom-Json }
    return $null
}

$WriteStarted = $false
try {
    $PipeNames = Get-ChildItem -LiteralPath '\\.\pipe\' |
        Where-Object Name -Match '^codex-app-tools-[0-9a-f-]{36}$' | Select-Object -ExpandProperty Name
    foreach ($PipeName in $PipeNames) {
        $Pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut)
        try {
            try { $Pipe.Connect(500) } catch [TimeoutException] { continue }
            if (-not [BridgeDesktopPipe]::BelongsToDesktop($Pipe.SafePipeHandle, $DesktopProcessId)) { continue }

            $Reader = [IO.BinaryReader]::new($Pipe, $Utf8, $true)
            $Catalog = Invoke-DesktopRpc $Pipe $Reader 'tools/list' @{ threadStartKind = 'all' }
            $SendTool = $Catalog.result.tools | Where-Object {
                $_.namespace -eq 'codex_app' -and $_.name -eq 'send_message_to_thread'
            } | Select-Object -First 1
            if (-not $SendTool) { continue }
            $Thread = Get-DesktopToolResult (Invoke-DesktopTool $Pipe $Reader 'read_thread' @{
                threadId = $ThreadId; turnLimit = 1; includeOutputs = $false
            })
            if ($Thread.thread.id -ne $ThreadId) { continue }

            if (-not $Request.send) { '{"status":"ready"}'; return }
            $Arguments = @{ threadId = $ThreadId; prompt = [string] $Request.prompt }
            if ($Request.model) {
                if (-not $SendTool.inputSchema.properties.model) { break }
                $Arguments.model = [string] $Request.model
            }
            if ($Request.effort) {
                if ($Request.effort -notin $SendTool.inputSchema.properties.thinking.enum) { break }
                $Arguments.thinking = [string] $Request.effort
            }
            # Report uncertainty after a write so the bridge cannot silently send a second copy.
            '{"status":"sending"}'
            [Console]::Out.Flush()
            $WriteStarted = $true
            $Response = Invoke-DesktopTool $Pipe $Reader 'send_message_to_thread' $Arguments
            $Delivery = Get-DesktopToolResult $Response
            if ($Delivery.threadId -eq $ThreadId) { '{"status":"accepted"}'; return }
            if ($Response.error.code -eq -32602 -or $Response.error.code -eq -32601) {
                '{"status":"unavailable"}'
                return
            }
            '{"status":"unconfirmed"}'
            return
        } finally {
            $Pipe.Dispose()
        }
    }
    '{"status":"unavailable"}'
} catch {
    if ($WriteStarted) { '{"status":"unconfirmed"}' } else { '{"status":"unavailable"}' }
}
