# Insurance for the case where the supervisor itself is gone: if nothing is listening on the
# port, ask the DshWebHost task to start again.
#
# Registered as its own scheduled task every 5 minutes (see docs/restart-protocol.md). It
# deliberately does nothing when the port is answering -- it never restarts a healthy host,
# because a restart mints a new token and invalidates every open browser session.
#
# Why this exists: the task action has been observed ending with 0xC000013A while the host
# kept running, and the supervise step is a child process of that action. A supervisor that
# dies leaves nothing behind; this is the only thing that would notice.

param(
  [int]$Port = 3080,
  [string]$TaskName = 'DshWebHost',
  [string]$TaskPath = '\'
)

$ErrorActionPreference = 'Continue'
$homeDir = Join-Path $env:USERPROFILE '.soulbridge'
$eventLog = Join-Path $homeDir 'web-supervisor.log'

function Write-Event([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message
  try { Add-Content -Path $eventLog -Value $line -Encoding utf8 -ErrorAction Stop }
  catch { Write-Warning "heartbeat log unavailable: $($_.Exception.Message)" }
}

$listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
if ($listening) { exit 0 }

Write-Event "heartbeat: nothing on port $Port, starting task $TaskName"
try {
  Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
} catch {
  Write-Event "heartbeat: could not start the task: $($_.Exception.Message)"
  exit 1
}
