# Keeps exactly one `dsh web` alive on the fixed port and republishes its launch URL.
#
# Launched hidden by web-host-hidden.vbs, which is the DshWebHost task's action.
#
# Why a supervisor instead of the action running cmd directly:
#   The task action used to be `cmd.exe /c web-host.cmd`, so the host lived in the action's
#   console. Closing that window ended the action with 0xC000013A while the host kept running
#   as an orphan (parent gone, task Ready) -- nothing supervised it, and a crash would have
#   left no host at all. Measured 2026-11-07: 25 starts on record, none of them supervised.
#
# What this does:
#   - one supervisor per user session (named mutex); a second exits instead of starting a
#     second host on the same port
#   - starts the host, waits for its token line, publishes web-url.txt + DSH-Web.url, and
#     does it again after every exit (crash or clean) -- the shortcut never points at the
#     previous process's token
#   - appends start/exit records to web-supervisor.log, so a crash restart is visible
#   - rotates web-host.log once it exceeds MaxLogBytes
#
# What this does not do: change profiles, touch other processes, kill a host it did not start
# (if the port is already busy it waits for it to free up), or open a browser.

param(
  [int]$Port = 3080,
  [string]$Profile = 'web',
  [int]$RestartDelaySeconds = 5,
  [long]$MaxLogBytes = 10485760
)

$ErrorActionPreference = 'Continue'

$homeDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
$log = Join-Path $homeDir 'web-host.log'
$eventLog = Join-Path $homeDir 'web-supervisor.log'
$urlFile = Join-Path $homeDir 'web-url.txt'
$shortcut = Join-Path $homeDir 'DSH-Web.url'

# The bundled CLI entry point lives behind web-host.cmd (it sets ELECTRON_RUN_AS_NODE and
# redirects the host's output into web-host.log); calling the .exe directly would drop both.
$webHostCmd = Join-Path $PSScriptRoot 'web-host.cmd'

function Write-Event([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message
  try { Add-Content -Path $eventLog -Value $line -Encoding utf8 -ErrorAction Stop }
  catch { Write-Warning "supervisor log unavailable: $($_.Exception.Message)" }
}

# One supervisor per session: two would race for the same port and the same URL file.
$mutex = New-Object System.Threading.Mutex($false, 'Local\DshWebHostSupervisor')
if (-not $mutex.WaitOne(0)) {
  Write-Event 'supervisor: another instance holds the mutex, exiting'
  exit 0
}

function Test-PortBusy {
  return (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0)
}

function Rotate-Log {
  if (-not (Test-Path $log)) { return }
  $size = (Get-Item $log).Length
  if ($size -le $MaxLogBytes) { return }
  $archived = "$log.1"
  Remove-Item $archived -Force -ErrorAction SilentlyContinue
  Move-Item $log $archived -Force -ErrorAction SilentlyContinue
  Write-Event "supervisor: rotated web-host.log at $size bytes"
}

function Publish-Url([string]$line) {
  $pattern = 'dsh web: (http://127\.0\.0\.1:' + $Port + '/\?token=\S+)'
  $match = [regex]::Match($line, $pattern)
  if (-not $match.Success) { return $false }
  $url = $match.Groups[1].Value
  try {
    Set-Content -Path $urlFile -Value $url -Encoding utf8
    @('[InternetShortcut]', "URL=$url") | Set-Content -Path $shortcut -Encoding ascii
    Write-Event "supervisor: published $url"
    return $true
  } catch {
    Write-Event "supervisor: could not publish the URL: $($_.Exception.Message)"
    return $false
  }
}

# Waits for a token line printed after $offset (so a stale line from the previous process
# cannot be mistaken for the new one), then publishes it.
function Wait-ForUrl([int]$offset, [int]$timeoutSeconds) {
  for ($waited = 0; $waited -lt $timeoutSeconds; $waited += 2) {
    Start-Sleep -Seconds 2
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
    if ($lines.Count -le $offset) { continue }
    $fresh = @($lines[$offset..($lines.Count - 1)] | Where-Object { $_ -match 'dsh web: http' })
    if ($fresh.Count -gt 0 -and (Publish-Url $fresh[-1])) { return $true }
  }
  return $false
}

Write-Event "supervisor: up (profile $Profile, port $Port, pid $PID)"

while ($true) {
  # A host we did not start owns the port: wait rather than start a second one on it.
  while (Test-PortBusy) {
    Write-Event "supervisor: port $Port already in use, waiting"
    Start-Sleep -Seconds 10
  }

  Rotate-Log
  $offset = @(Get-Content $log -ErrorAction SilentlyContinue).Count
  Write-Event "supervisor: starting host"

  if (-not (Test-Path $webHostCmd)) {
    Write-Event "supervisor: missing $webHostCmd, nothing to start"
    exit 1
  }
  if ($webHostCmd -match ' ') {
    Write-Event 'supervisor: web-host.cmd path contains a space; start may need quoting'
  }

  try {
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $webHostCmd -WindowStyle Hidden -PassThru
  } catch {
    Write-Event "supervisor: could not start the host: $($_.Exception.Message)"
    Start-Sleep -Seconds $RestartDelaySeconds
    continue
  }

  if (-not (Wait-ForUrl $offset 180)) {
    Write-Event 'supervisor: host did not print a token URL within 180s'
  }

  $proc.WaitForExit()
  Write-Event "supervisor: host exited (code $($proc.ExitCode)); restarting in ${RestartDelaySeconds}s"
  Start-Sleep -Seconds $RestartDelaySeconds
}
