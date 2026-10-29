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
  [switch]$SkipFallback
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

function Get-ListenerCount {
  $pids = (Get-AppProcesses | ForEach-Object { $_.Id })
  if (-not $pids) { return 0 }
  return @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess }).Count
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
  $sawListener = $false
  while ($elapsed -lt $StableSeconds) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    $count = (Get-AppProcesses).Count
    if ($count -eq 0) {
      Write-Log "${label}: process disappeared after ${elapsed}s"
      Write-LatestCrash
      return $false
    }
    if (-not $sawListener -and (Get-ListenerCount) -gt 0) {
      $sawListener = $true
      Write-Log "${label}: webhost listening after ${elapsed}s"
    }
  }

  Write-Log "${label}: stable for ${StableSeconds}s (processes: $((Get-AppProcesses).Count), listener: $sawListener)"
  return $sawListener
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

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  if (Start-AndWatch "attempt $attempt") {
    Write-Log 'done (plugin intact)'
    exit 0
  }
  Write-Log "attempt $attempt failed"
}

if ($SkipFallback) {
  Write-Log 'FAILED: no stable start, fallback skipped'
  exit 1
}

# Fallback: ship a working app without the plugin rather than no app at all.
Write-Log 'fallback: disabling the soulbridge bundle'
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
