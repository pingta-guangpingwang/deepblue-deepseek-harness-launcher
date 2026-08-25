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
$joinFixture = Join-Path $qaRoot 'join-fixture'
New-Item -ItemType Directory -Path $joinFixture -Force | Out-Null
$partOne = Join-Path $joinFixture 'part-001'
$partTwo = Join-Path $joinFixture 'part-002'
$joined = Join-Path $joinFixture 'joined.bin'
[IO.File]::WriteAllBytes($partOne, [byte[]](1, 2, 3, 4))
[IO.File]::WriteAllBytes($partTwo, [byte[]](5, 6, 7))
function Get-TestSha256([string]$file) {
  $stream = [IO.File]::OpenRead($file)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}
$expectedJoined = Join-Path $joinFixture 'expected.bin'
[IO.File]::WriteAllBytes($expectedJoined, [byte[]](1, 2, 3, 4, 5, 6, 7))
& $verifier --join $joined (Get-TestSha256 $expectedJoined) 7 $partOne (Get-TestSha256 $partOne) 4 $partTwo (Get-TestSha256 $partTwo) 3
if ($LASTEXITCODE -ne 0 -or (Get-TestSha256 $joined) -ne (Get-TestSha256 $expectedJoined)) { throw "Hash verifier could not reassemble signed parts ($LASTEXITCODE)." }
$appRoot = Join-Path $qaRoot ('shells\' + [string]$metadata.version)
$app = Join-Path $appRoot ([string]$metadata.executable)
$legacyQaRoot = if (Test-Path -LiteralPath 'D:\' -PathType Container) { Join-Path 'D:\' ('DeepBlueInstallerPathQA-' + [guid]::NewGuid().ToString('N')) } else { Join-Path $env:TEMP ('DeepBlueInstallerPathQA-' + [guid]::NewGuid().ToString('N')) }
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

  # Reproduce an upgrade from the legacy electron-builder installer: it stored
  # only a GUID uninstall record, often without InstallLocation. The bootstrap
  # must recover the custom root from UninstallString and must not fall back to C:.
  $currentKey = 'HKCU:\Software\DeepBlue\DeepSeekHarnessLauncher'
  $legacyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\078eda7a-bb67-538c-a4c8-0b0ff5470883'
  $currentItem = Get-ItemProperty -LiteralPath $currentKey -ErrorAction SilentlyContinue
  $legacyItem = Get-ItemProperty -LiteralPath $legacyKey -ErrorAction SilentlyContinue
  $currentHadInstallRoot = $null -ne $currentItem -and $currentItem.PSObject.Properties.Name -contains 'InstallRoot'
  $legacyHadInstallLocation = $null -ne $legacyItem -and $legacyItem.PSObject.Properties.Name -contains 'InstallLocation'
  $legacyHadUninstall = $null -ne $legacyItem -and $legacyItem.PSObject.Properties.Name -contains 'UninstallString'
  $savedInstallRoot = if ($currentHadInstallRoot) { [string]$currentItem.InstallRoot } else { $null }
  $savedInstallLocation = if ($legacyHadInstallLocation) { [string]$legacyItem.InstallLocation } else { $null }
  $savedUninstall = if ($legacyHadUninstall) { [string]$legacyItem.UninstallString } else { $null }
  try {
    New-Item -ItemType Directory -Path $currentKey -Force | Out-Null
    Remove-ItemProperty -LiteralPath $currentKey -Name InstallRoot -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $legacyKey -Force | Out-Null
    Set-ItemProperty -LiteralPath $legacyKey -Name InstallLocation -Value ''
    New-Item -ItemType Directory -Path $legacyQaRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacyQaRoot 'previous-install.marker') -Value 'legacy custom install root'
    Set-ItemProperty -LiteralPath $legacyKey -Name UninstallString -Value ('"' + (Join-Path $legacyQaRoot 'Uninstall 深蓝DeepSeekHarness启动器.exe') + '" /currentuser')
    & $installer /S /QA "/LOCAL_SHELL=$shell"
    $legacyApp = Join-Path $legacyQaRoot ('shells\' + [string]$metadata.version + '\' + [string]$metadata.executable)
    for ($attempt = 0; $attempt -lt 120 -and -not (Test-Path -LiteralPath $legacyApp -PathType Leaf); $attempt += 1) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $legacyApp -PathType Leaf)) { throw "Bootstrap ignored the previous custom install root: $legacyQaRoot" }
    Write-Host "Previous custom install root smoke passed: $legacyQaRoot"
  } finally {
    if ($currentHadInstallRoot) { Set-ItemProperty -LiteralPath $currentKey -Name InstallRoot -Value $savedInstallRoot }
    else { Remove-ItemProperty -LiteralPath $currentKey -Name InstallRoot -ErrorAction SilentlyContinue }
    if ($legacyHadInstallLocation) { Set-ItemProperty -LiteralPath $legacyKey -Name InstallLocation -Value $savedInstallLocation }
    else { Remove-ItemProperty -LiteralPath $legacyKey -Name InstallLocation -ErrorAction SilentlyContinue }
    if ($legacyHadUninstall) { Set-ItemProperty -LiteralPath $legacyKey -Name UninstallString -Value $savedUninstall }
    else { Remove-ItemProperty -LiteralPath $legacyKey -Name UninstallString -ErrorAction SilentlyContinue }
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
  $resolvedLegacyQa = [IO.Path]::GetFullPath($legacyQaRoot)
  $safeLegacyPrefix = if ($resolvedLegacyQa.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) { 'D:\DeepBlueInstallerPathQA-' } else { Join-Path $tempRoot 'DeepBlueInstallerPathQA-' }
  if ($resolvedLegacyQa.StartsWith($safeLegacyPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedLegacyQa -Recurse -Force -ErrorAction SilentlyContinue
  }
}
