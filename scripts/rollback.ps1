# 回滚插件安装：删除目录联接、从 bundles 里摘掉、可选恢复 package.json 备份。
# 用法：pwsh -File rollback.ps1 [-RestoreBackup <package.json.bak-...>]
param(
  [string]$Profile = 'D:\DSH\home\profiles\desktop',
  [string]$Package = 'dsh-plugin-soulbridge',
  [string]$RestoreBackup
)

$ErrorActionPreference = 'Stop'
$link = Join-Path $Profile "node_modules\$Package"
$manifest = Join-Path $Profile 'package.json'

if (Test-Path $link) {
  (Get-Item $link).Delete()
  "removed junction: $link"
} else {
  "junction not present: $link"
}

if ($RestoreBackup) {
  if (-not (Test-Path $RestoreBackup)) { throw "backup not found: $RestoreBackup" }
  Copy-Item $RestoreBackup $manifest -Force
  "restored manifest from $RestoreBackup"
} else {
  $json = Get-Content $manifest -Raw -Encoding utf8 | ConvertFrom-Json
  $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $Package })
  $json | ConvertTo-Json -Depth 10 | Set-Content $manifest -Encoding utf8
  "removed '$Package' from dsh.profile.bundles"
}

"done. restart DSH to take effect."
