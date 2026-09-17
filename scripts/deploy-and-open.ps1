param(
  [int]$StartPort = 8080,
  [int]$EndPort = 8090,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$Message) {
  Write-Host "[智学双擎] $Message" -ForegroundColor Cyan
}

function Test-ZhixueHealth([int]$Port) {
  try {
    $response = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
    return [bool]$response.success
  } catch {
    return $false
  }
}

function Find-AvailablePort {
  for ($port = $StartPort; $port -le $EndPort; $port++) {
    if (Test-ZhixueHealth $port) {
      return @{ Port = $port; Reuse = $true }
    }

    try {
      $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        $port
      )
      $listener.Start()
      $listener.Stop()
      return @{ Port = $port; Reuse = $false }
    } catch {
      continue
    }
  }
  throw "端口 $StartPort 到 $EndPort 均被占用，请关闭占用程序后重试。"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js。请安装 Node.js 22.13 或更高版本后重试。"
}

$runtimeDirectory = Join-Path $root "data\runtime"
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

$selection = Find-AvailablePort
$port = $selection.Port
$url = "http://127.0.0.1:$port/"

if (-not $selection.Reuse) {
  Write-Step "正在启动本地服务，端口 $port..."
  $process = Start-Process `
    -FilePath "node" `
    -ArgumentList @("server/local-api.mjs", "--host", "127.0.0.1", "--port", "$port") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) {
      throw "本地服务启动失败，请检查 Node.js 版本和 data/zhixue_demo.sqlite。"
    }
    if (Test-ZhixueHealth $port) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "本地服务在 9 秒内未就绪，请检查端口和数据库文件。"
  }

  @{
    pid = $process.Id
    port = $port
    url = $url
    startedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDirectory "server.json") -Encoding UTF8
} else {
  Write-Step "检测到本地服务已在运行，直接打开现有实例。"
}

Write-Step "部署完成，正在打开 $url"
if (-not $NoOpen) {
  Start-Process $url
}
