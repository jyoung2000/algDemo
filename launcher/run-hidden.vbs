' Runs a sibling PowerShell script with no console window: wscript run-hidden.vbs <script.ps1> [args]
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\" & WScript.Arguments(0) & """"
sh.Run cmd, 0, False
