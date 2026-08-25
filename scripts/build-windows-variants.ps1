param([switch]$SkipOffline)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDirectory = Join-Path $projectRoot 'release'
$sourceDirectory = Join-Path $releaseDirectory 'win-unpacked'
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$version = [string]$package.version
$builder = Join-Path $PSScriptRoot 'build-nsis-installer.ps1'

if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
  throw "Packaged Windows directory not found: $sourceDirectory"
}

Write-Host 'Synchronizing production peer dependencies required by Harness...'
& node (Join-Path $PSScriptRoot 'sync-runtime-peers.mjs')
if ($LASTEXITCODE -ne 0) {
  throw "Runtime peer synchronization failed (exit code $LASTEXITCODE)."
}

$offlineFile = Join-Path $releaseDirectory "deepblue-deepseek-harness-launcher-$version-win-x64-offline.exe"
$onlineFile = Join-Path $releaseDirectory "deepblue-deepseek-harness-launcher-$version-win-x64-online.exe"
$offlineAlias = Join-Path $releaseDirectory '深蓝DeepSeekHarness启动器-完整离线版.exe'
$onlineAlias = Join-Path $releaseDirectory '深蓝DeepSeekHarness启动器-在线轻量版.exe'

$staleFiles = @($onlineFile, $onlineAlias, $offlineAlias)
if (-not $SkipOffline) {
  $staleFiles += $offlineFile
}
foreach ($stale in $staleFiles) {
  if (Test-Path -LiteralPath $stale) {
    Remove-Item -LiteralPath $stale -Force
  }
}

if (-not $SkipOffline) {
  Write-Host 'Building the complete offline one-click installer...'
  & $builder -SourceDirectory $sourceDirectory -OutputFile $offlineFile -Edition offline
  if ($LASTEXITCODE -ne 0) {
    throw "Offline installer build failed (exit code $LASTEXITCODE)."
  }
} elseif (-not (Test-Path -LiteralPath $offlineFile -PathType Leaf)) {
  throw "Cannot skip the offline build because its artifact is missing: $offlineFile"
}

Write-Host 'Building signed-catalog runtime module artifacts before pruning...'
& npm run modules:build
if ($LASTEXITCODE -ne 0) {
  throw "Runtime module packaging failed (exit code $LASTEXITCODE)."
}
& npm run modules:smoke
if ($LASTEXITCODE -ne 0) {
  throw "Runtime module smoke failed (exit code $LASTEXITCODE)."
}
$packagedResources = Join-Path $sourceDirectory 'resources\resources'
New-Item -ItemType Directory -Path $packagedResources -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $releaseDirectory 'runtime-modules.generated.json') -Destination (Join-Path $packagedResources 'runtime-modules.generated.json') -Force

Write-Host 'Building the modular Electron UI shell...'
& npm run shell:build
if ($LASTEXITCODE -ne 0) {
  throw "Launcher shell packaging failed (exit code $LASTEXITCODE)."
}

Write-Host 'Verifying packaged cold start without a renderer reload...'
& npm run qa:packaged:cold-start
if ($LASTEXITCODE -ne 0) {
  throw "Packaged cold-start QA failed (exit code $LASTEXITCODE)."
}

Write-Host 'Building and testing the sub-megabyte online bootstrap...'
& npm run bootstrap:build
if ($LASTEXITCODE -ne 0) {
  throw "Online bootstrap build failed (exit code $LASTEXITCODE)."
}
& npm run bootstrap:smoke-local-artifact
if ($LASTEXITCODE -ne 0) {
  throw "Local-artifact bootstrap smoke failed (exit code $LASTEXITCODE)."
}
Copy-Item -LiteralPath (Join-Path $releaseDirectory 'deepblue-deepseek-harness-launcher-win-x64-online-bootstrap.exe') -Destination $onlineFile -Force

& node (Join-Path $PSScriptRoot 'finalize-windows-artifacts.mjs')
if ($LASTEXITCODE -ne 0) {
  throw "Artifact finalization failed (exit code $LASTEXITCODE)."
}
