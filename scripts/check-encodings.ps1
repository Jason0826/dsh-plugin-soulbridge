# Fail when any tracked text file starts with a UTF-8 BOM.
# The desktop host JSON.parse()s manifests without stripping a BOM, so one
# stray BOM silently disables a bundle (it is reported only on stderr).
param([string]$Root = (Split-Path $PSScriptRoot -Parent))

$patterns = '*.json', '*.yml', '*.yaml', '*.js', '*.mjs', '*.cjs', '*.md', '*.ps1'
$bad = @()
Get-ChildItem $Root -Recurse -File -Include $patterns -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules' } |
  ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $bad += $_.FullName.Replace($Root + '\', '')
    }
  }

if ($bad.Count -gt 0) {
  "BOM found in:"; $bad | ForEach-Object { "  $_" }; exit 1
}
"no BOM in tracked text files"