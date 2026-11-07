' The DshWebHost scheduled task's action: run the host supervisor with no console window.
'
' Why not `cmd.exe /c web-host.cmd` as the action:
'   the task runs in the interactive session, so cmd shows a console. Closing that window
'   ends the action with 0xC000013A while the host keeps running unsupervised -- and nothing
'   restarts it afterwards. wscript has no console of its own, and the supervisor starts its
'   child with -WindowStyle Hidden, so there is no window to close by accident.
'
' The supervisor, not this launcher, is what keeps one host alive and republishes the URL.
Dim shell, folder, supervisor
Set shell = CreateObject("WScript.Shell")
folder = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
supervisor = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & folder & "web-host-supervisor.ps1"""
' 0 = hidden window, True = wait for it, so the task stays Running while the host runs.
shell.Run supervisor, 0, True
