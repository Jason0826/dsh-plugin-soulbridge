# Restart DSH with crash detection, retries, and a safety fallback.
#
# Why a scheduled task: the desktop app puts its children in a job object, so a
# script spawned from inside the app dies with it. Task Scheduler runs this
# process independently.
#
# Why the stability window: the app can start, report processes, and then crash
# ~15s later (observed: authenticateWebHost fetch fails with "bad port" when the
# randomly chosen webhost port is on undici's blocked list). Exiting as soon as
# a process exists is not enough; we watch for a full stable window.
#
# Fallback: if every attempt crashes, remove the soulbridge bundle from the
# profile and try once more, so the app comes back without the plugin instead of
# staying down. Removal uses the BOM-safe manifest editor.
param(
  [int]$DelaySeconds = 180,
  [string]$Exe = 'C:\Users\DELL\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe',
  [string]$ProcessName = 'DeepSeek Harness',
  [int]$MaxAttempts = 3,
  [int]$StableSeconds = 45,
  [string]$Profile = 'D:\DSH\home\profiles\desktop',
  [string]$Bundle = 'dsh-plugin-soulbridge',
  # Point the plugin at a different home (config, database, logs). Used to run
  # experiments against a throwaway database instead of the real one.
  [string]$SoulbridgeHome = '',
  # Delete the Electron cookie store before starting.
  #
  # The desktop app picks a random webhost port on every start and names its auth
  # cookie after host:port, with a 30-day life and no pruning. Each start adds one
  # cookie (~228 bytes), and once the accumulated request header passes Node's
  # 16KB limit the app fails its startup handshake with "Web authentication
  # failed" — the 431 the crash log does not spell out. Clearing the store here
  # keeps it bounded, because this script is how the app is restarted.
  [switch]$CleanCookies,
  [switch]$SkipFallback,
  # The fallback removes the soulbridge bundle from the profile. That is destructive and
  # was triggered by a false "did not start" on 2026-11-03, so it is opt-in now.
  [switch]$AllowBundleRemoval
)

$logDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'restart.log'
$cancel = Join-Path $logDir 'restart.cancel'
$crashDir = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs'
$manifestTool = 'D:\git-workspace\repos\dsh-plugin-soulbridge\scripts\profile-manifest.ps1'

function Write-Log([string]$message) {
  "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message | Add-Content -Path $log -Encoding utf8
}

function Get-AppProcesses {
  return @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
}

# Listening sockets can be owned by a child process (the webhost runs under an Electron
# helper), so counting only the main process pids reports False while the app is serving —
# observed 2026-11-03: three "starts failed" in a row against a healthy app. Walk the
# process tree instead.
function Get-ListenerCount {
  $appPids = @(Get-AppProcesses | ForEach-Object { $_.Id })
  if ($appPids.Count -eq 0) { return 0 }
  try {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Select-Object ProcessId, ParentProcessId)
  } catch {
    return -1  # unknown: callers must not treat this as "not listening"
  }
  $tree = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($id in $appPids) { [void]$tree.Add([int]$id) }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($proc in $all) {
      if ($tree.Contains([int]$proc.ParentProcessId) -and -not $tree.Contains([int]$proc.ProcessId)) {
        [void]$tree.Add([int]$proc.ProcessId)
        $grew = $true
      }
    }
  }
  return @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $tree.Contains([int]$_.OwningProcess) }).Count
}

function Write-LatestCrash {
  $crash = Get-ChildItem $crashDir -File -Filter 'crash-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $crash) { Write-Log 'no crash log found'; return }
  Write-Log "latest crash log: $($crash.Name)"
  $firstError = (Get-Content $crash.FullName -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'Error' } | Select-Object -First 2) -join ' | '
  if ($firstError) { Write-Log "crash hint: $firstError" }
}

# Launch the app and watch it for the full stability window.
# Returns $true when the process survives and the webhost is listening.
function Start-AndWatch([string]$label) {
  Write-Log "${label}: launching"
  if ($SoulbridgeHome -ne '') {
    $env:SOULBRIDGE_HOME = $SoulbridgeHome
    Write-Log "${label}: SOULBRIDGE_HOME=$SoulbridgeHome"
  }
  try { Start-Process -FilePath $Exe | Out-Null } catch {
    Write-Log "${label}: start threw: $($_.Exception.Message)"; return $false
  }

  $elapsed = 0
  $listenerState = 'unknown'   # 'listening' | 'none' | 'unknown'
  while ($elapsed -lt $StableSeconds) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    $count = (Get-AppProcesses).Count
    if ($count -eq 0) {
      Write-Log "${label}: process disappeared after ${elapsed}s"
      Write-LatestCrash
      return $false
    }
    $listeners = Get-ListenerCount
    if ($listeners -gt 0 -and $listenerState -ne 'listening') {
      $listenerState = 'listening'
      Write-Log "${label}: webhost listening after ${elapsed}s"
    } elseif ($listeners -eq 0 -and $listenerState -eq 'unknown') {
      $listenerState = 'none'
    }
  }

  Write-Log "${label}: stable for ${StableSeconds}s (processes: $((Get-AppProcesses).Count), listener: $listenerState)"
  # Process stability is the signal that matters. A missed listener is a measurement gap,
  # not proof of failure — treating it as failure is what triggered a bogus bundle removal.
  if ($listenerState -eq 'none') { Write-Log "${label}: listener not observed; accepting process stability" }
  return $true
}

Write-Log "scheduled: waiting ${DelaySeconds}s before restart"
Start-Sleep -Seconds $DelaySeconds

if (Test-Path $cancel) {
  Write-Log 'cancelled by sentinel file'
  Remove-Item $cancel -Force -ErrorAction SilentlyContinue
  exit 0
}

$pids = (Get-AppProcesses | ForEach-Object { $_.Id }) -join ','
Write-Log "stopping app (pids: $pids)"
Get-AppProcesses | Stop-Process -Force
Start-Sleep -Seconds 4
Write-Log "processes remaining after stop: $((Get-AppProcesses).Count)"

# Inspect (and optionally clear) the Electron cookie store while it is unlocked.
# The file is locked by the running app, so this is the only window to read it.
$cookieDir = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Network'
$cookieFile = Join-Path $cookieDir 'Cookies'
# The store grows by one cookie per start (~228 bytes) with a 30-day life and no pruning.
# Node rejects the request header past 16KB, so waiting for the crash is waiting for a
# restart loop. Clear on size instead: 12KB leaves margin, and a normal start stays under it.
$cookieLimitBytes = 12 * 1024
if (Test-Path $cookieFile) {
  $cookieBytes = (Get-Item $cookieFile).Length
  Write-Log "cookies: $cookieBytes bytes before start (limit $cookieLimitBytes)"
  if ($CleanCookies -or $cookieBytes -gt $cookieLimitBytes) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $logDir "cookies-backup-$stamp.db"
    try {
      Copy-Item $cookieFile $backup -Force
      Remove-Item $cookieFile -Force
      Remove-Item (Join-Path $cookieDir 'Cookies-journal') -Force -ErrorAction SilentlyContinue
      $why = if ($CleanCookies) { 'requested' } else { 'over limit' }
      Write-Log "cookies: cleared ($why, backup $backup)"
    } catch {
      Write-Log "cookies: clear failed: $($_.Exception.Message)"
    }
  }
} else {
  Write-Log 'cookies: store not found'
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  if (Start-AndWatch "attempt $attempt") {
    Write-Log 'done (plugin intact)'
    exit 0
  }
  Write-Log "attempt $attempt failed"
}

if ($SkipFallback -or -not $AllowBundleRemoval) {
  # Removing the bundle is destructive and one false "did not start" is enough to trigger it
  # (measured 2026-11-03: three bogus failures against a healthy app). Report instead of
  # acting; an operator decides whether the plugin is the cause.
  Write-Log 'FAILED: app did not stay up; soulbridge bundle left untouched'
  Write-Log 'if you are sure the plugin is the cause: rerun with -AllowBundleRemoval'
  Write-LatestCrash
  exit 1
}

# Opt-in fallback: ship a working app without the plugin rather than no app at all.
Write-Log 'fallback: disabling the soulbridge bundle (explicit -AllowBundleRemoval)'
try {
  & 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass `
    -File $manifestTool -Action remove-bundle -Name $Bundle *>> $log
} catch {
  Write-Log "fallback: manifest tool failed: $($_.Exception.Message)"
}

if (Start-AndWatch 'fallback attempt') {
  Write-Log "done (plugin disabled - re-enable with profile-manifest.ps1 -Action add-bundle -Name $Bundle)"
  exit 0
}

Write-Log 'FAILED: app does not stay up even without the plugin; manual attention needed'
exit 1
