param(
  [int]$Port = 8080,
  [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$bundledNode = Join-Path $root "runtime\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
  $nodeExecutable = $bundledNode
} else {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if (-not $systemNode) {
    throw "运行环境不完整：未找到 runtime\node.exe，也未检测到系统 Node.js。请重新解压完整免安装包。"
  }
  $nodeExecutable = $systemNode.Source
}

Write-Host "正在启动智学双擎本地服务..."
Write-Host "访问地址：http://${HostAddress}:$Port"
Write-Host "按 Ctrl+C 停止服务。"
& $nodeExecutable server/local-api.mjs --host $HostAddress --port $Port
