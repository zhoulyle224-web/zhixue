param(
  [int]$Port = 8080,
  [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js。请安装 Node.js 22.13 或更高版本后重试。"
}

Write-Host "正在启动智学双擎本地服务..."
Write-Host "访问地址：http://${HostAddress}:$Port"
Write-Host "按 Ctrl+C 停止服务。"
node server/local-api.mjs --host $HostAddress --port $Port
