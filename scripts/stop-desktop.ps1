# Stop the desktop client so only one host writes soulbridge state.
#
# Two hosts at once means two extraction queues and two writers against the same
# ~/.soulbridge database, plus two WeChat bridges on one account. Used after switching to
# the CLI web profile: the web host keeps serving, the desktop shell goes away.
param(
  [string]$ProcessName = 'DeepSeek Harness',
  [int]$DelaySeconds = 0
)

$logDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'web-host.log'
function Write-Log([string]$message) {
  "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message | Add-Content -Path $log -Encoding utf8
}

if ($DelaySeconds -gt 0) {
  Write-Log "stop-desktop: waiting ${DelaySeconds}s"
  Start-Sleep -Seconds $DelaySeconds
}

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Write-Log 'stop-desktop: already stopped'
  exit 0
}
Write-Log "stop-desktop: stopping $($procs.Count) processes"
$procs | Stop-Process -Force
Start-Sleep -Seconds 4
$left = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue).Count
Write-Log "stop-desktop: remaining $left"
