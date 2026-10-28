# 延时重启 DSH。放在独立进程里跑，避免把承载当前会话的进程杀死在半路。
# 取消：在重启发生前创建 ~/.soulbridge/restart.cancel 文件即可。
param(
  [int]$DelaySeconds = 300,
  [string]$Exe = 'C:\Users\DELL\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe',
  [string]$ProcessName = 'DeepSeek Harness'
)

$logDir = Join-Path $env:USERPROFILE '.soulbridge'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'restart.log'
$cancel = Join-Path $logDir 'restart.cancel'

function Write-Log([string]$message) {
  "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message | Add-Content -Path $log -Encoding utf8
}

Write-Log "scheduled: waiting ${DelaySeconds}s before restart"
Start-Sleep -Seconds $DelaySeconds

if (Test-Path $cancel) {
  Write-Log 'cancelled by sentinel file'
  Remove-Item $cancel -Force -ErrorAction SilentlyContinue
  exit 0
}

Write-Log 'stopping app'
Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

$remaining = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue).Count
Write-Log "processes remaining after stop: $remaining"

Write-Log 'starting app'
Start-Process -FilePath $Exe
Start-Sleep -Seconds 5

$started = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue).Count
Write-Log "processes after start: $started"
Write-Log 'done'
