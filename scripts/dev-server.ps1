param(
  [ValidateSet('Start','Stop','Status')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$local = Join-Path $root '.local'
$pidFile = Join-Path $local 'ballance-dev.pid'
$logFile = Join-Path $local 'ballance-dev.log'
$errorLogFile = Join-Path $local 'ballance-dev.err.log'
$url = 'http://127.0.0.1:5173/'
New-Item -ItemType Directory -Force -Path $local | Out-Null

function Get-ServerProcess {
  if (!(Test-Path -LiteralPath $pidFile)) { return $null }
  $saved = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $serverPid = 0
  if (![int]::TryParse($saved, [ref]$serverPid)) { return $null }
  return Get-Process -Id $serverPid -ErrorAction SilentlyContinue
}

function Test-Url {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

switch ($Action) {
  'Start' {
    $process = Get-ServerProcess
    if ($process -and !$process.HasExited) {
      Write-Output "Ballance dev server is already running (PID $($process.Id))."
      exit 0
    }
    if (Test-Url) {
      Write-Output "Port 5173 is already serving Ballance; reusing it."
      exit 0
    }

    $node = Join-Path $root '.tools\node-v22.18.0-win-x64\node.exe'
    if (!(Test-Path -LiteralPath $node)) {
      $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
      if (!$nodeCommand) { throw 'Node.js was not found. Run Setup-Ballance.bat first.' }
      $node = $nodeCommand.Source
    }
    $vite = Join-Path $root 'node_modules\vite\bin\vite.js'
    if (!(Test-Path -LiteralPath $vite)) { throw 'node_modules\vite is missing. Run Setup-Ballance.bat first.' }

    $arguments = @('"' + $vite + '"', '--host', '127.0.0.1', '--port', '5173')
    $server = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errorLogFile -PassThru
    Set-Content -LiteralPath $pidFile -Value $server.Id -Encoding ascii
    Write-Output "Started Ballance dev server (PID $($server.Id)); log: $logFile"
    exit 0
  }
  'Stop' {
    $process = Get-ServerProcess
    if ($process -and !$process.HasExited) {
      Stop-Process -Id $process.Id -Force
      Write-Output "Stopped Ballance dev server (PID $($process.Id))."
    } else {
      Write-Output 'Ballance dev server is not running.'
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
  }
  'Status' {
    $process = Get-ServerProcess
    if ($process -and !$process.HasExited) {
      Write-Output "Ballance dev server is running (PID $($process.Id)) at $url"
      exit 0
    }
    Write-Output 'Ballance dev server is not running.'
    exit 1
  }
}
