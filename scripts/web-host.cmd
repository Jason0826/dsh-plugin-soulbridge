@echo off
rem The web host itself, run as the action of the DshWebHost scheduled task.
rem The task stays Running for as long as this process lives, which is what keeps the host
rem alive after the task's launcher exits (a one-shot wrapper loses the job object).
"C:\Users\DELL\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web --host 127.0.0.1 --port 3080 --no-open >> "%USERPROFILE%\.soulbridge\web-host.log" 2>&1
