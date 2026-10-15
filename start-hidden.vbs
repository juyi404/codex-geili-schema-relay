' Windowless launcher for the scheduled task: wscript is a GUI host, so unlike
' powershell.exe it never flashes a console window when Task Scheduler fires.
Dim shell, scriptDir
Set shell = CreateObject("Wscript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "start.ps1""", 0, False
