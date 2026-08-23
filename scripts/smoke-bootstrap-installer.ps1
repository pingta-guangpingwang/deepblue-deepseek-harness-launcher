$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$metadata = Get-Content -LiteralPath (Join-Path $releaseRoot 'launcher-shell.generated.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = Join-Path $releaseRoot 'deepblue-deepseek-harness-launcher-win-x64-online-bootstrap.exe'
$shell = Join-Path $releaseRoot ([string]$metadata.fileName)
$verifier = Join-Path $releaseRoot '.bootstrap-build\HashVerifier.exe'
foreach ($required in @($installer, $shell, $verifier)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Bootstrap smoke input is missing: $required" }
}

& $verifier $shell ([string]$metadata.sha256) ([string]$metadata.size)
if ($LASTEXITCODE -ne 0) { throw "Hash verifier rejected the authentic shell ($LASTEXITCODE)." }
& $verifier $shell ('0' * 64) ([string]$metadata.size)
if ($LASTEXITCODE -ne 4) { throw "Hash verifier did not reject a wrong digest ($LASTEXITCODE)." }

$qaRoot = Join-Path $env:TEMP ('deepblue-bootstrap-smoke-' + [guid]::NewGuid().ToString('N'))
$appRoot = Join-Path $qaRoot ('shells\' + [string]$metadata.version)
$app = Join-Path $appRoot ([string]$metadata.executable)
$appProcess = $null
try {
  & $installer /S /QA "/LOCAL_SHELL=$shell" "/D=$qaRoot"
  for ($attempt = 0; $attempt -lt 120 -and -not (Test-Path -LiteralPath $app -PathType Leaf); $attempt += 1) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw 'Bootstrap did not install the launcher shell within 30 seconds.' }
  foreach ($forbidden in @('node', 'pnpm', '@deepseek-ai\dsh')) {
    if (Test-Path -LiteralPath (Join-Path $appRoot ('resources\app\node_modules\' + $forbidden))) {
      throw "Launcher shell still carries a runtime module: $forbidden"
    }
  }
  foreach ($requiredPackage in @('tar', 'yaml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot ('resources\app\node_modules\' + $requiredPackage + '\package.json')) -PathType Leaf)) {
      throw "Launcher shell is missing required package: $requiredPackage"
    }
  }

  $userData = Join-Path $qaRoot 'electron-user-data'
  $appProcess = Start-Process -FilePath $app -ArgumentList @("--user-data-dir=$userData", '--disable-gpu') -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 7
  if ($appProcess.HasExited) { throw "Launcher shell exited during startup ($($appProcess.ExitCode))." }
  Write-Host "Local-artifact bootstrap smoke passed. This fast check does not satisfy the public fresh-install release gate."
} finally {
  if ($appProcess -and -not $appProcess.HasExited) { & taskkill.exe /pid $appProcess.Id /t /f | Out-Null }
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP + [IO.Path]::DirectorySeparatorChar)
  $resolvedQa = [IO.Path]::GetFullPath($qaRoot)
  if ($resolvedQa.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedQa).StartsWith('deepblue-bootstrap-smoke-')) {
    Remove-Item -LiteralPath $resolvedQa -Recurse -Force -ErrorAction SilentlyContinue
  }
}
