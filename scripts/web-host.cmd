@echo off
rem The web host itself. Started (hidden) by web-host-supervisor.ps1, which keeps it alive and
rem republishes its token URL; the scheduled task's action is web-host-hidden.vbs, never this
rem file directly -- a task whose action is cmd shows a console, and closing that window ends
rem the action (0xC000013A) while the host runs on as an orphan.
rem Output is appended here and read back by the restart script and the supervisor.
"C:\Users\DELL\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web --host 127.0.0.1 --port 3080 --no-open >> "%USERPROFILE%\.soulbridge\web-host.log" 2>&1
