# BOM-safe editor for a DSH profile manifest.
#
# Why this exists: the desktop host does JSON.parse() on package.json without
# stripping a BOM, so a manifest written by Windows PowerShell's
# `Set-Content -Encoding utf8` (which emits EF BB BF) makes the app fail to
# start with "Unexpected token". This script is the only supported way to
# touch the manifest: it writes UTF-8 without BOM and validates after writing.
#
# Usage:
#   powershell -File profile-manifest.ps1 check
#   powershell -File profile-manifest.ps1 add-bundle    -Name <package>
#   powershell -File profile-manifest.ps1 remove-bundle -Name <package>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('check', 'add-bundle', 'remove-bundle')]
  [string]$Action,
  [string]$Name,
  [string]$Profile = 'D:\DSH\home\profiles\desktop'
)

$ErrorActionPreference = 'Stop'
$manifest = Join-Path $Profile 'package.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-ManifestBytes {
  return [System.IO.File]::ReadAllBytes($manifest)
}

function Test-Bom {
  $b = Get-ManifestBytes
  return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

function Read-Manifest {
  $bytes = Get-ManifestBytes
  $offset = 0
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $offset = 3 }
  $text = [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
  return ($text | ConvertFrom-Json)
}

function Write-Manifest([object]$json) {
  $text = ($json | ConvertTo-Json -Depth 12) + "`n"
  [System.IO.File]::WriteAllText($manifest, $text, $utf8NoBom)
}

function Assert-Valid {
  $bytes = Get-ManifestBytes
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw 'manifest has a UTF-8 BOM; the desktop host will refuse to parse it'
  }
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  $null = $text | ConvertFrom-Json
  return 'valid: no BOM, JSON parses'
}

switch ($Action) {
  'check' {
    "bom: $(Test-Bom)"
    $json = Read-Manifest
    "bundles: " + (@($json.dsh.profile.bundles) -join ', ')
    Assert-Valid
  }

  'add-bundle' {
    if (-not $Name) { throw '-Name is required for add-bundle' }
    $json = Read-Manifest
    $bundles = @($json.dsh.profile.bundles)
    if ($bundles -contains $Name) {
      "already present: $Name"
    } else {
      $json.dsh.profile.bundles = @($bundles) + $Name
      Write-Manifest $json
      "added: $Name"
    }
    Assert-Valid
  }

  'remove-bundle' {
    if (-not $Name) { throw '-Name is required for remove-bundle' }
    $json = Read-Manifest
    $before = @($json.dsh.profile.bundles)
    $json.dsh.profile.bundles = @($before | Where-Object { $_ -ne $Name })
    Write-Manifest $json
    "removed: $Name (was $(@($before).Count), now $(@($json.dsh.profile.bundles).Count))"
    Assert-Valid
  }
}
