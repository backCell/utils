Option Explicit

Dim fso, scriptDir, ps1, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\install.ps1"

cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """"

CreateObject("Wscript.Shell").Run cmd, 0, True
