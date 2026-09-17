param(
  [string]$TargetDirectory = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "data\zhixue_demo.sqlite"
if (-not $TargetDirectory) {
  $TargetDirectory = Join-Path $root "backups"
}
New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $TargetDirectory "zhixue_demo-$stamp.sqlite"
Copy-Item -LiteralPath $source -Destination $target
Write-Host "备份完成：$target"
