param(
  [string]$InstallerUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download/deepblue-deepseek-harness-launcher-win-x64-online.exe',
  [int]$TimeoutMinutes = 20,
  [switch]$KeepInstallation
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$qaRoot = Join-Path $env:TEMP ('deepblue-public-fresh-install-' + [guid]::NewGuid().ToString('N'))
$installerFile = Join-Path $qaRoot 'public-online-installer.exe'
$installRoot = Join-Path $qaRoot 'installed-program'
$outputRoot = Join-Path $projectRoot 'output\playwright\public-fresh-install'
$installerProcess = $null

function Remove-VerifiedQaRoot([string]$Target) {
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP + [IO.Path]::DirectorySeparatorChar)
  $resolved = [IO.Path]::GetFullPath($Target)
  if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('deepblue-public-fresh-install-')) {
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  New-Item -ItemType Directory -Path $qaRoot | Out-Null
  if (-not $InstallerUrl.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) { throw 'Public installer gate requires HTTPS.' }

  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $true
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(3)
  try {
    $response = $client.GetAsync($InstallerUrl, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "Anonymous installer download returned HTTP $([int]$response.StatusCode)." }
    $contentType = [string]$response.Content.Headers.ContentType.MediaType
    if ($contentType -match 'xml|html') { throw "Anonymous installer download returned $contentType instead of an executable." }
    $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $output = [IO.File]::Create($installerFile)
    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
  } finally {
    if ($response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
  }

  $installerInfo = Get-Item -LiteralPath $installerFile
  if ($installerInfo.Length -lt 100000) { throw "Anonymous installer download is unexpectedly small: $($installerInfo.Length) bytes." }
  $installerSha256 = (Get-FileHash -LiteralPath $installerFile -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "Downloaded anonymous public installer: $($installerInfo.Length) bytes, SHA256 $installerSha256"

  $installerProcess = Start-Process -FilePath $installerFile -ArgumentList @('/S', '/QA', "/D=$installRoot") -PassThru -WindowStyle Hidden
  $installerDeadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
  while (-not $installerProcess.HasExited -and [DateTime]::UtcNow -lt $installerDeadline) {
    Start-Sleep -Milliseconds 500
    $installerProcess.Refresh()
  }
  if (-not $installerProcess.HasExited) {
    & taskkill.exe /pid $installerProcess.Id /t /f | Out-Null
    throw "Public online installer did not finish within $TimeoutMinutes minutes."
  }
  if ($installerProcess.ExitCode -ne 0) { throw "Public online installer failed with exit code $($installerProcess.ExitCode)." }

  $app = Join-Path $installRoot ("shells\{0}\深蓝DeepSeekHarness启动器.exe" -f [string]$package.version)
  if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw "Public installer did not install launcher $($package.version)." }
  $runtimeRoot = Join-Path $qaRoot 'fresh-storage\runtime\modules'
  if (Test-Path -LiteralPath $runtimeRoot) { throw 'Fresh-install gate was not clean before the launcher started.' }

  $env:QA_PUBLIC_LAUNCHER_EXE = $app
  $env:QA_PUBLIC_ROOT = $qaRoot
  $env:QA_PUBLIC_OUTPUT = $outputRoot
  $env:QA_PUBLIC_TIMEOUT_MS = [string]($TimeoutMinutes * 60 * 1000)
  & node (Join-Path $PSScriptRoot 'qa-public-fresh-install.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Public launcher/Harness QA failed with exit code $LASTEXITCODE." }

  $report = Get-Content -LiteralPath (Join-Path $outputRoot 'public-fresh-install-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $summary = [ordered]@{
    passed = $true
    installerUrl = $InstallerUrl
    installerSha256 = $installerSha256
    installerBytes = $installerInfo.Length
    launcherVersion = $report.launcherVersion
    harnessVersion = $report.harnessVersion
    observedSources = $report.observedSources
    testedAt = $report.testedAt
  }
  $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot 'public-gate-summary.json') -Encoding UTF8
  Write-Host "PUBLIC FRESH-INSTALL GATE PASSED: launcher $($report.launcherVersion), Harness $($report.harnessVersion)."
} finally {
  Remove-Item Env:QA_PUBLIC_LAUNCHER_EXE,Env:QA_PUBLIC_ROOT,Env:QA_PUBLIC_OUTPUT,Env:QA_PUBLIC_TIMEOUT_MS -ErrorAction SilentlyContinue
  if ($installerProcess -and -not $installerProcess.HasExited) { & taskkill.exe /pid $installerProcess.Id /t /f | Out-Null }
  if (-not $KeepInstallation) { Remove-VerifiedQaRoot $qaRoot }
}
