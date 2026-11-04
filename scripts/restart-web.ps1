# Restart the CLI web host on its fixed port, then hand back a working token URL.
#
# Why not just launch `dsh web`: the host is the action of the DshWebHost scheduled task, so
# stopping/starting the task replaces it cleanly and the task keeps the process alive.
#
# Why the .url file: every start mints a new launch token and the browser cookie from the
# previous start is invalid. Writing the new token URL into a shortcut means a restart does
# not need a human to copy a line out of a log.
param(
  [int]$Port = 3080,
  [int]$DelaySeconds = 0,
  [int]$WaitSeconds = 90,
  [string]$TaskName = 'DshWebHost',
  [string]$ProcessName = 'DeepSeek Harness',
  [switch]$KeepDesktop,
  [switch]$NoBrowser,
  # Emergency escape only: a red review gate means the batch was not looked at as a whole.
  [switch]$SkipReviewGate
)

$homeDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
$log = Join-Path $homeDir 'web-host.log'
$urlFile = Join-Path $homeDir 'web-url.txt'
$shortcut = Join-Path $homeDir 'DSH-Web.url'

function Write-Log([string]$message) {
  "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message | Add-Content -Path $log -Encoding utf8
}

function Get-HostPids {
  $pids = @()
  foreach ($conn in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    if ($conn.OwningProcess -gt 0) { $pids += [int]$conn.OwningProcess }
  }
  return $pids | Select-Object -Unique
}

if ($DelaySeconds -gt 0) {
  Write-Log "web-restart: waiting ${DelaySeconds}s"
  Start-Sleep -Seconds $DelaySeconds
}

# 0. Refuse to deploy without the review the checklist asks for.
#
# The health-check review gate fires after commits, while the habit was to run health-check
# before committing — so it was always green at the moment someone looked and red afterwards.
# Putting it in front of the restart is the only place that cannot be skipped.
$repoRoot = 'D:\git-workspace\repos\soulbridge'
$healthScript = Join-Path $repoRoot 'scripts\health-check.mjs'
if ((Test-Path $healthScript) -and -not $SkipReviewGate) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  $node = if ($cmd) { $cmd.Source } else { $null }
  if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
  if ($node) {
    $health = & $node $healthScript --no-tests 2>&1 | Out-String
    if ($health -match '✗ \[review\]') {
      Write-Log 'web-restart: REFUSED - the review gate is red (write a docs/audit review first)'
      ($health -split "`n" | Where-Object { $_ -match 'review' } | Select-Object -First 2) |
        ForEach-Object { Write-Log "web-restart: $_" }
      exit 1
    }
    Write-Log 'web-restart: review gate ok'
  } else {
    Write-Log 'web-restart: node not on PATH; review gate skipped'
  }
}

# 1. One runtime, one client: the desktop app must go before the web host can own it.
if (-not $KeepDesktop) {
  $desktop = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  if ($desktop.Count -gt 0) {
    Write-Log "web-restart: stopping desktop ($($desktop.Count) processes)"
    $desktop | Stop-Process -Force
    Start-Sleep -Seconds 6
  }
}

# 2. Stop the previous host: the task first (it owns the tree), then any straggler on the port.
$before = (Get-Content $log -ErrorAction SilentlyContinue | Measure-Object).Count
$existing = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  Write-Log "web-restart: stopping task $TaskName"
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
  Start-Sleep -Seconds 3
}
foreach ($pid in Get-HostPids) {
  Write-Log "web-restart: killing pid $pid still on port $Port"
  Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# 3. Start it and wait for the new token line.
Write-Log "web-restart: starting task $TaskName"
Start-ScheduledTask -TaskName $TaskName

$url = $null
for ($waited = 0; $waited -lt $WaitSeconds; $waited += 2) {
  Start-Sleep -Seconds 2
  $listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count
  if ($listening -eq 0) { continue }
  $line = Get-Content $log -ErrorAction SilentlyContinue |
    Select-Object -Skip $before |
    Where-Object { $_ -match "dsh web: http://127\.0\.0\.1:$Port/\?token=" } |
    Select-Object -Last 1
  if ($line) {
    $url = ($line -split 'dsh web: ')[1].Trim()
    break
  }
}

if (-not $url) {
  Write-Log "web-restart: FAILED - no token URL on port $Port within ${WaitSeconds}s"
  exit 1
}

# 4. Persist it where a restart needs only one click.
Set-Content -Path $urlFile -Value $url -Encoding utf8
@(
  '[InternetShortcut]'
  "URL=$url"
) | Set-Content -Path $shortcut -Encoding ascii
Write-Log "web-restart: ready at $url (shortcut: $shortcut)"

if (-not $NoBrowser) {
  Start-Process $url | Out-Null
  Write-Log 'web-restart: opened browser'
}

exit 0
