Option Explicit

Dim shell, fileSystem, root, powerShellPath, watchdogPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
watchdogPath = fileSystem.BuildPath(root, "watchdog.ps1")
command = """" & powerShellPath & """ -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & watchdogPath & """"

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
