param(
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $root "data\runtime\server.json"

function Write-Step([string]$Message) {
  if (-not $Quiet) { Write-Host "[智学双擎] $Message" -ForegroundColor Cyan }
}

if (-not (Test-Path -LiteralPath $metadataPath)) {
  Write-Step "当前目录没有正在运行的一键部署服务，可以直接删除此版本文件夹。"
  exit 0
}

$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$pidValue = [int]$metadata.pid
$port = [int]$metadata.port
$instanceId = [string]$metadata.instanceId
if ($pidValue -le 0 -or $port -le 0 -or [string]::IsNullOrWhiteSpace($instanceId)) {
  throw "服务记录不完整，为避免终止错误进程，本次未执行停止操作。"
}

$serviceProcess = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $serviceProcess) {
  Remove-Item -LiteralPath $metadataPath -Force
  Write-Step "服务已经停止，旧记录已清理，可以删除此版本文件夹。"
  exit 0
}
if ($serviceProcess.ProcessName -ne "node") {
  throw "记录的 PID 已被其他程序使用，为避免误操作，本次未终止任何进程。"
}

try {
  $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2
} catch {
  throw "无法确认 PID $pidValue 是否仍为本目录服务，为避免误操作，本次未终止任何进程。"
}
if (-not $health.success -or $health.instanceId -ne $instanceId) {
  throw "端口响应与本目录实例指纹不一致，为避免误操作，本次未终止任何进程。"
}

Stop-Process -Id $pidValue -Force
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}
if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
  throw "服务未能停止，请关闭相关页面后重试。"
}
Remove-Item -LiteralPath $metadataPath -Force
Write-Step "服务已停止，可以删除此版本文件夹。"
