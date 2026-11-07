# Restart the CLI web host on its fixed port, then hand back a working token URL.
#
# Why not just launch `dsh web`: the host is the action of the DshWebHost scheduled task, so
# stopping/starting the task replaces it cleanly. The task is a launcher, not a supervisor:
# it has been seen recording 0xC000013A and ending while the host lived on as an orphan, so
# nothing here may assume "the task is Running" means "the host is alive". Stopping the task
# and then waiting for the process tree to actually disappear is the only safe replace.
#
# Why the .url file: every start mints a new launch token and the browser cookie from the
# previous start is invalid. Writing the new token URL into a shortcut means a restart does
# not need a human to copy a line out of a log.
#
# Why a separate restart log: the host is launched with `>> web-host.log`, so it holds that
# file open for its whole life. Appending to the same file from here fails with "file in use"
# exactly while the host runs -- which is when the interesting lines are written (ready /
# FAILED) -- so those lines were silently lost: 25 starts on record, 0 "ready at" lines
# (2026-11-07). Restart bookkeeping goes to web-restart.log; web-host.log stays the host's.
#
# Exit codes, because a restart loop needs to tell "it worked" from "it was refused":
#   0  host is up and the URL was published
#   2  another restart held the lock for the whole LockWaitSeconds
#   3  the task was started but no token URL appeared within WaitSeconds
#   4  the review gate refused (health-check --gate=review is red)
param(
  [int]$Port = 3080,
  [int]$DelaySeconds = 0,
  [int]$WaitSeconds = 120,
  # A restart asked for while another one runs waits for it instead of being dropped.
  [int]$LockWaitSeconds = 180,
  # The review gate is re-used while it is this fresh: a dev loop restarts far more often
  # than the review can meaningfully change. A red gate still re-runs every time.
  [int]$GateMaxAgeSeconds = 300,
  [string]$TaskName = 'DshWebHost',
  [string]$ProcessName = 'DeepSeek Harness',
  # Only needed if a desktop window is open: matching the image name alone would also hit the
  # web host this script is replacing.
  [switch]$StopDesktop,
  # Only opens a browser tab when asked. Unattended restarts must not leave dead tabs behind.
  [switch]$OpenBrowser,
  # Emergency escape only: a red review gate means the batch was not looked at as a whole.
  [switch]$SkipReviewGate
)

$homeDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
$log = Join-Path $homeDir 'web-host.log'
# The host's own stdout; never appended to from here (it is held open by the `>>` redirect).
$restartLog = Join-Path $homeDir 'web-restart.log'
$urlFile = Join-Path $homeDir 'web-url.txt'
$shortcut = Join-Path $homeDir 'DSH-Web.url'
$gateStamp = Join-Path $homeDir 'web-restart-gate.stamp'
$lockFile = Join-Path $homeDir 'web-restart.lock'

$exitBusy = 2
$exitNotReady = 3
$exitGateRed = 4

function Write-Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message
  try {
    Add-Content -Path $restartLog -Value $line -Encoding utf8 -ErrorAction Stop
  } catch {
    # A restart must never die because bookkeeping could not be written.
    Write-Warning "web-restart log unavailable: $($_.Exception.Message)"
  }
}

# Every process that could still own this port: listeners, plus anything still holding the
# command line (a host that started but has not bound the port yet would otherwise be missed,
# and the next start would put a second host beside it).
function Get-HostPids {
  $ids = @()
  foreach ($conn in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    if ($conn.OwningProcess -gt 0) { $ids += [int]$conn.OwningProcess }
  }
  $pattern = "--port\s+$Port(\s|$)"
  foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if (-not $proc.CommandLine) { continue }
    if ($proc.CommandLine -match $pattern) { $ids += [int]$proc.ProcessId }
  }
  return $ids | Select-Object -Unique
}

$lockHeld = $false

try {
  # 0. One restart at a time. The task engine drops a second Start-ScheduledTask silently
  #    (MultipleInstances=IgnoreNew), so a dev loop that restarts too fast must queue here
  #    and say so, not look like it restarted when it did nothing.
  $lockDeadline = (Get-Date).AddSeconds($LockWaitSeconds)
  while (-not $lockHeld -and (Get-Date) -lt $lockDeadline) {
    try {
      $stream = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$PID $(Get-Date -Format o)")
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Close()
      $lockHeld = $true
    } catch {
      # A lock whose owner is gone is a leftover, not a running restart.
      $ownerId = 0
      try {
        $ownerText = Get-Content $lockFile -ErrorAction Stop | Select-Object -First 1
        if ($ownerText) { $ownerId = [int](($ownerText -split ' ')[0]) }
      } catch { }
      if ($ownerId -gt 0 -and -not (Get-Process -Id $ownerId -ErrorAction SilentlyContinue)) {
        Write-Log "lock: clearing stale lock of pid $ownerId"
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
        continue
      }
      Start-Sleep -Seconds 2
    }
  }

  if (-not $lockHeld) {
    Write-Log "BUSY - another restart still holds $lockFile after ${LockWaitSeconds}s"
    exit $exitBusy
  }

  if ($DelaySeconds -gt 0) {
    Write-Log "waiting ${DelaySeconds}s"
    Start-Sleep -Seconds $DelaySeconds
  }

  # 1. Refuse to deploy without the review the checklist asks for, unless that review is
  #    still fresh. The decision is an exit code, not a string match: PowerShell 5.1 decodes
  #    child output with the system code page, and a regex on that once refused a clean deploy.
  $repoRoot = 'D:\git-workspace\repos\soulbridge'
  $healthScript = Join-Path $repoRoot 'scripts\health-check.mjs'
  if ((Test-Path $healthScript) -and -not $SkipReviewGate) {
    $gateAge = [double]::MaxValue
    if (Test-Path $gateStamp) { $gateAge = ((Get-Date) - (Get-Item $gateStamp).LastWriteTime).TotalSeconds }
    if ($gateAge -lt $GateMaxAgeSeconds) {
      Write-Log "gate: reusing a green review $([int]$gateAge)s old"
    } else {
      $cmd = Get-Command node -ErrorAction SilentlyContinue
      $node = if ($cmd) { $cmd.Source } else { $null }
      if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
      if ($node) {
        $null = & $node $healthScript --no-tests --gate=review 2>&1
        if ($LASTEXITCODE -ne 0) {
          Write-Log 'REFUSED - the review gate is red (write a docs/audit review first)'
          exit $exitGateRed
        }
        Set-Content -Path $gateStamp -Value (Get-Date -Format o) -Encoding utf8
        Write-Log 'gate: ok'
      } else {
        Write-Log 'gate: node not on PATH, skipped'
      }
    }
  }

  # 2. One runtime, one client: an actual desktop window has to go first. Kill by image name
  #    alone and the web host dies too, so only do it on request and only for real desktop
  #    processes (they run the app, not cli.js).
  if ($StopDesktop) {
    $desktop = @(Get-CimInstance Win32_Process -Filter "Name='$ProcessName.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -notmatch 'cli\.js' })
    if ($desktop.Count -gt 0) {
      Write-Log "stopping desktop ($($desktop.Count) processes)"
      $desktop | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 6
    }
  }

  # 3. Stop the previous host and wait for it to really be gone. A fixed sleep is a guess:
  #    start too early next to a dying process and the port is taken twice.
  $before = @(Get-Content $log -ErrorAction SilentlyContinue).Count
  $existing = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    Write-Log "stopping task $TaskName"
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
  }

  $stopDeadline = (Get-Date).AddSeconds(20)
  while ($true) {
    $remaining = @(Get-HostPids)
    if ($remaining.Count -eq 0) { break }
    if ((Get-Date) -gt $stopDeadline) {
      foreach ($hostPid in $remaining) {
        Write-Log "killing pid $hostPid that outlived the task stop"
        Stop-Process -Id $hostPid -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 2
      break
    }
    Start-Sleep -Milliseconds 500
  }

  # 4. Start it and wait for a token line printed after the stop, so a stale line from the
  #    previous process cannot be handed back as if it were the new one.
  Write-Log "starting task $TaskName"
  Start-ScheduledTask -TaskName $TaskName

  $url = $null
  for ($waited = 0; $waited -lt $WaitSeconds; $waited += 2) {
    Start-Sleep -Seconds 2
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
    if ($lines.Count -le $before) { continue }
    $fresh = @($lines[$before..($lines.Count - 1)] |
      Where-Object { $_ -match "dsh web: http://127\.0\.0\.1:$Port/\?token=" })
    if ($fresh.Count -gt 0) {
      $url = ($fresh[-1] -split 'dsh web: ')[1].Trim()
      break
    }
  }

  if (-not $url) {
    Write-Log "NOT READY - no token URL on port $Port within ${WaitSeconds}s"
    exit $exitNotReady
  }

  # 5. Persist it where a restart needs only one click. The supervisor does this too when it
  #    restarts a crashed host; both write the same files, so either path leaves it current.
  Set-Content -Path $urlFile -Value $url -Encoding utf8
  @(
    '[InternetShortcut]'
    "URL=$url"
  ) | Set-Content -Path $shortcut -Encoding ascii
  Write-Log "ready at $url (shortcut: $shortcut)"

  # Opening a tab is opt-in: the token URL changes on every restart, so the old tab cannot be
  # reused -- but auto-opening on every unattended restart left a browser full of dead tabs.
  if ($OpenBrowser) {
    Start-Process $url | Out-Null
    Write-Log 'opened browser'
  }

  exit 0
}
finally {
  if ($lockHeld) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
}
