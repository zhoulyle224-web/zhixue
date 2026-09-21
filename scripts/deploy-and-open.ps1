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

function Get-ZhixueInstanceId {
  $identityFiles = @(
    (Join-Path $root "package.json"),
    (Join-Path $root "server\local-api.mjs"),
    (Join-Path $root "teacher.html")
  )
  $parts = @($root.ToLowerInvariant())
  foreach ($path in $identityFiles) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "启动文件不完整：缺少 $path"
    }
    $parts += (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($parts -join "|"))
    $digest = [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
    return "zhixue-$($digest.Substring(0, 24))"
  } finally {
    $sha256.Dispose()
  }
}

function Test-ZhixueHealth([int]$Port, [string]$ExpectedInstanceId) {
  try {
    $response = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
    return [bool]$response.success -and $response.instanceId -eq $ExpectedInstanceId
  } catch {
    return $false
  }
}

function Find-AvailablePort([string]$ExpectedInstanceId) {
  for ($port = $StartPort; $port -le $EndPort; $port++) {
    if (Test-ZhixueHealth $port $ExpectedInstanceId) {
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

$bundledNode = Join-Path $root "runtime\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
  $nodeExecutable = $bundledNode
  Write-Step "使用项目内置 Node 运行环境。"
} else {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if (-not $systemNode) {
    throw "运行环境不完整：未找到 runtime\node.exe，也未检测到系统 Node.js。请重新解压完整免安装包。"
  }
  $nodeExecutable = $systemNode.Source
  Write-Step "未发现内置运行环境，使用系统 Node.js。"
}

$runtimeDirectory = Join-Path $root "data\runtime"
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

$instanceId = Get-ZhixueInstanceId
$selection = Find-AvailablePort $instanceId
$port = $selection.Port
$url = "http://127.0.0.1:$port/?instance=$instanceId"

if (-not $selection.Reuse) {
  Write-Step "正在启动本地服务，端口 $port..."
  $serverEntry = Join-Path $root "server\local-api.mjs"
  $process = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @($serverEntry, "--host", "127.0.0.1", "--port", "$port", "--instance", $instanceId) `
    -WorkingDirectory ([System.IO.Path]::GetTempPath()) `
    -WindowStyle Hidden `
    -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) {
      throw "本地服务启动失败，请检查 Node.js 版本和 data/zhixue_demo.sqlite。"
    }
    if (Test-ZhixueHealth $port $instanceId) {
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
    instanceId = $instanceId
    startedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDirectory "server.json") -Encoding UTF8
} else {
  Write-Step "检测到当前版本已在运行，直接打开同一实例。"
}

Write-Step "部署完成，正在打开 $url"
Write-Step "删除本版本前，请先双击 stop-service.bat 或 停止智学双擎服务.bat。"
if (-not $NoOpen) {
  Start-Process $url
}
