param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,
  [string]$PlanPath,
  [string]$ManifestPath,
  [string]$SourceDirectory,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
function Stop-OwnedHandoffProcesses([string[]]$ExecutablePaths, [string]$InstallerDirectory, [int]$TimeoutMilliseconds = 10000) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $owned = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and (($ExecutablePaths -contains $_.ExecutablePath) -or $_.ExecutablePath.StartsWith($InstallerDirectory + '\', [StringComparison]::OrdinalIgnoreCase))
    })
    if ($owned.Count -eq 0) { return }
    if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) { throw 'Owned QA processes did not exit within the cleanup timeout; host restoration is blocked.' }
    $handles = @($owned | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if ($handles.Count -eq 0) { Start-Sleep -Milliseconds 50; continue }
    try {
      foreach ($handle in $handles) { Stop-Process -InputObject $handle -ErrorAction SilentlyContinue }
      foreach ($handle in $handles) {
        $remaining = [int][Math]::Max(0, $TimeoutMilliseconds - $timer.ElapsedMilliseconds)
        if (-not $handle.WaitForExit($remaining)) { throw 'Owned QA process exit could not be confirmed; host restoration is blocked.' }
      }
    } finally {
      foreach ($handle in $handles) { $handle.Dispose() }
    }
    # Rescan after exit so a child launched during installer shutdown is covered.
  }
}
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$node = (Get-Command node -ErrorAction Stop).Source
$gate = Join-Path $PSScriptRoot 'qa-launcher-041-installer-handoff.mjs'
if (-not $PlanPath) { $PlanPath = Join-Path $projectRoot 'release\release-041-plan.json' }
if (-not $ManifestPath) { $ManifestPath = Join-Path $projectRoot 'release\launcher-manifest.041.dsh02.json' }
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $projectRoot 'release\win-unpacked' }
$outputParent = [IO.Path]::GetFullPath((Join-Path $projectRoot 'output\qa-041-handoff'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $outputParent ('r-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith($outputParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use a dedicated child of output\qa-041-handoff.' }
if ((Join-Path $output ('profile\home\AppData\Roaming\deepseek-harness-launcher\updates\' + ('f' * 64) + '.exe')).Length -ge 260) { throw 'Use a shorter unique output directory; the native installer cache path must stay below MAX_PATH.' }
if (Test-Path -LiteralPath $output) { throw 'QA output must be new; existing evidence is never replaced.' }
$savedEnvironment = @{}
foreach ($name in @('EXPECTED_RELEASE_041_PLAN_SHA256', 'QA_HANDOFF_PLAN', 'QA_HANDOFF_MANIFEST', 'QA_HANDOFF_SOURCE', 'QA_HANDOFF_OUTPUT', 'QA_HANDOFF_HOST_BACKUP_READY')) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$registry = @(
  'HKCU\Software\DeepBlue\DeepSeekHarnessLauncher',
  'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepBlueDeepSeekHarnessLauncher',
  'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\078eda7a-bb67-538c-a4c8-0b0ff5470883'
)
$registryBackups = @()
$fileBackups = @()
$directoryBackups = @()
$restoreFailures = [Collections.Generic.List[string]]::new()
$gateStarted = $false
$gateExit = 1
try {
  $env:EXPECTED_RELEASE_041_PLAN_SHA256 = $PlanSha256
  $env:QA_HANDOFF_PLAN = [IO.Path]::GetFullPath($PlanPath)
  $env:QA_HANDOFF_MANIFEST = [IO.Path]::GetFullPath($ManifestPath)
  $env:QA_HANDOFF_SOURCE = [IO.Path]::GetFullPath($SourceDirectory)
  $env:QA_HANDOFF_OUTPUT = $output
  & $node $gate --preflight
  if ($LASTEXITCODE -ne 0) { throw 'Handoff preflight failed; no host state was changed.' }
  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $backupRoot = Join-Path $output 'host-state-backup'
  New-Item -ItemType Directory -Path $backupRoot | Out-Null
  for ($index = 0; $index -lt $registry.Count; $index++) {
    $key = $registry[$index]
    $provider = 'Registry::HKEY_CURRENT_USER\' + $key.Substring(5)
    $exists = Test-Path -LiteralPath $provider
    $backup = Join-Path $backupRoot ('registry-' + $index + '.reg')
    if ($exists) {
      & reg.exe export $key $backup /y | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Cannot completely export $key; installer will not run." }
    }
    $registryBackups += [pscustomobject]@{ Key = $key; Existed = $exists; Backup = $backup }
  }
  $product = '深蓝DeepSeekHarness启动器'
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  $programFolders = @([Environment]::GetFolderPath('Programs'), (Join-Path $output 'profile\home\AppData\Roaming\Microsoft\Windows\Start Menu\Programs')) | Select-Object -Unique
  $shortcutPaths = @((Join-Path $desktop ($product + '.lnk')))
  foreach ($programs in $programFolders) {
    if (-not $programs) { throw 'Cannot resolve the user Start Menu folder.' }
    $folder = Join-Path $programs $product
    $directoryBackups += [pscustomobject]@{ Path = $folder; Existed = (Test-Path -LiteralPath $folder) }
    $shortcutPaths += Join-Path $programs ($product + '.lnk')
    $shortcutPaths += Join-Path $folder ($product + '.lnk')
  }
  $fileIndex = 0
  foreach ($file in ($shortcutPaths | Select-Object -Unique)) {
    $exists = Test-Path -LiteralPath $file -PathType Leaf
    $backup = Join-Path $backupRoot ('shortcut-' + $fileIndex + '.lnk')
    $record = [ordered]@{ Path = $file; Existed = $exists; Backup = $backup; Sha256 = $null; Created = $null; Modified = $null; Attributes = $null }
    if ($exists) {
      $item = Get-Item -LiteralPath $file
      $record.Created = $item.CreationTimeUtc; $record.Modified = $item.LastWriteTimeUtc; $record.Attributes = $item.Attributes
      Copy-Item -LiteralPath $file -Destination $backup
      $record.Sha256 = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash
      if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $record.Sha256) { throw 'Shortcut backup verification failed.' }
    }
    $fileBackups += [pscustomobject]$record
    $fileIndex++
  }
  [pscustomobject]@{ Output = $output; Registry = $registryBackups; Shortcuts = $fileBackups; Directories = $directoryBackups } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backupRoot 'inventory.json') -Encoding UTF8
  # Even a broken /D parser must never fall back to the user's registered
  # installation. A distinct, harmless fallback also proves that /D won.
  $gateStarted = $true
  $fallbackRoot = Join-Path $output 'safe alternate installer default'
  $fixtureInstall = Join-Path $output 'install with spaces'
  New-Item -ItemType Directory -Path $fallbackRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $fallbackRoot 'fallback-must-not-be-installed.marker') -Value 'Only the explicit spaced /D destination may receive the new shell.'
  for ($index = 0; $index -lt $registry.Count; $index++) {
    $provider = 'Registry::HKEY_CURRENT_USER\' + $registry[$index].Substring(5)
    New-Item -Path $provider -Force | Out-Null
    if ($index -eq 0) { Set-ItemProperty -LiteralPath $provider -Name InstallRoot -Value $fallbackRoot }
    else {
      $location = if ($index -eq 2) { $fixtureInstall } else { $fallbackRoot }
      Set-ItemProperty -LiteralPath $provider -Name InstallLocation -Value $location
      Set-ItemProperty -LiteralPath $provider -Name UninstallString -Value ('"' + (Join-Path $location 'fixture-never-run-uninstaller.exe') + '"')
    }
  }
  # All backups exist before exposing the token that allows real installation.
  $env:QA_HANDOFF_HOST_BACKUP_READY = '1'
  & $node $gate
  $gateExit = $LASTEXITCODE
} finally {
  if ($gateStarted) {
    # Exact owned fixture paths only. A failed Node gate must not leave its
    # installer or restarted app racing the host-state restoration below.
    $install = Join-Path $output 'install with spaces'
    $ownedExecutables = @((Join-Path $install 'shells\0.10.39\深蓝DeepSeekHarness启动器.exe'), (Join-Path $install 'shells\0.10.41\深蓝DeepSeekHarness启动器.exe'), (Join-Path $output 'safe alternate installer default\shells\0.10.41\深蓝DeepSeekHarness启动器.exe'))
    $ownedProcessesExited = $false
    try {
      $installerPrefix = Join-Path $output 'profile\home\AppData\Roaming\deepseek-harness-launcher\updates'
      Stop-OwnedHandoffProcesses -ExecutablePaths $ownedExecutables -InstallerDirectory $installerPrefix
      $ownedProcessesExited = $true
    } catch { $restoreFailures.Add('Isolated process cleanup: ' + $_.Exception.Message) }
    if ($ownedProcessesExited) {
      foreach ($record in $registryBackups) {
        try {
          $provider = 'Registry::HKEY_CURRENT_USER\' + $record.Key.Substring(5)
          if (Test-Path -LiteralPath $provider) { & reg.exe delete $record.Key /f | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Exact key removal failed' } }
          if ($record.Existed) {
            & reg.exe import $record.Backup | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Full registry import failed' }
            $readback = $record.Backup + '.restored.reg'
            & reg.exe export $record.Key $readback /y | Out-Null
            if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $readback -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $record.Backup -Algorithm SHA256).Hash) { throw 'Restored registry export differs from the full backup' }
          } elseif (Test-Path -LiteralPath $provider) { throw 'Originally absent registry key remains after restoration' }
        } catch { $restoreFailures.Add($record.Key + ': ' + $_.Exception.Message) }
      }
      foreach ($record in $fileBackups) {
        try {
          if ($record.Existed) {
            Copy-Item -LiteralPath $record.Backup -Destination $record.Path -Force
            $item = Get-Item -LiteralPath $record.Path
            $item.CreationTimeUtc = $record.Created; $item.LastWriteTimeUtc = $record.Modified; $item.Attributes = $record.Attributes
            if ((Get-FileHash -LiteralPath $record.Path -Algorithm SHA256).Hash -ne $record.Sha256) { throw 'Restored shortcut differs from backup' }
          } elseif (Test-Path -LiteralPath $record.Path -PathType Leaf) { Remove-Item -LiteralPath $record.Path -Force }
        } catch { $restoreFailures.Add($record.Path + ': ' + $_.Exception.Message) }
      }
      foreach ($record in $directoryBackups) {
        try {
          if (-not $record.Existed -and (Test-Path -LiteralPath $record.Path -PathType Container) -and @(Get-ChildItem -LiteralPath $record.Path -Force).Count -eq 0) { Remove-Item -LiteralPath $record.Path }
        } catch { $restoreFailures.Add($record.Path + ': ' + $_.Exception.Message) }
      }
    }
    [pscustomobject]@{ Restored = ($restoreFailures.Count -eq 0); OwnedProcessesExited = $ownedProcessesExited; Failures = @($restoreFailures); GateExitCode = $gateExit; EvidenceRetained = $output } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'host-state-restore.json') -Encoding UTF8
  }
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
if ($restoreFailures.Count) { throw ('Host-state restoration needs attention; backups retained at ' + $output + ': ' + ($restoreFailures -join '; ')) }
if ($gateExit -ne 0) { throw "Installer handoff QA failed ($gateExit); evidence retained at $output" }
Write-Output "Installer handoff QA and exact host-state restoration passed: $output"
