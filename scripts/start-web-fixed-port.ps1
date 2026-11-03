# Switch the running client to the CLI web profile on a fixed port.
#
# Why: the desktop launcher hardcodes `--port 0`, so the webhost authority (and the auth
# cookie it names) changes on every start; the cookie store grows until Node rejects the
# request header. The web profile is CLI-managed, so `--port` actually applies.
#
# Why a scheduled task: the script has to stop the desktop app, and a process spawned from
# inside that app dies with it. Task Scheduler runs this independently.
#
# Safety: if the fixed-port host never answers, put the desktop app back rather than leave
# the machine without a client.
param(
  [int]$Port = 3080,
  [int]$DelaySeconds = 0,
  [int]$WaitSeconds = 90,
  [string]$DshCli = 'C:\Users\DELL\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$Exe = 'C:\Users\DELL\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe',
  [string]$ProcessName = 'DeepSeek Harness',
  [switch]$OpenBrowser
)

$logDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'web-host.log'

function Write-Log([string]$message) {
  "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message | Add-Content -Path $log -Encoding utf8
}

if ($DelaySeconds -gt 0) {
  Write-Log "switch: waiting ${DelaySeconds}s"
  Start-Sleep -Seconds $DelaySeconds
}

$desktop = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($desktop.Count -gt 0) {
  Write-Log "switch: stopping desktop ($($desktop.Count) processes)"
  $desktop | Stop-Process -Force
  Start-Sleep -Seconds 6
} else {
  Write-Log 'switch: desktop not running'
}

$command = "`"$DshCli`" --profile web --host 127.0.0.1 --port $Port --no-open"
Write-Log "switch: starting web host: $command"
Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden `
  -ArgumentList "/c `"$command >> `"$log`" 2>&1`""

$ok = $false
for ($waited = 0; $waited -lt $WaitSeconds; $waited += 2) {
  Start-Sleep -Seconds 2
  $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($listening.Count -gt 0) {
    Write-Log "switch: web host listening on 127.0.0.1:$Port after $($waited + 2)s"
    $ok = $true
    break
  }
}

if ($ok) {
  if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:$Port" | Out-Null
    Write-Log 'switch: opened browser'
  }
  Write-Log 'switch: done (fixed port)'
  exit 0
}

Write-Log "switch: web host did not listen on $Port within ${WaitSeconds}s; restoring desktop app"
Write-Log 'switch: see the dsh output above for the reason'
Start-Process -FilePath $Exe | Out-Null
Write-Log 'switch: desktop launched as fallback'
exit 1
