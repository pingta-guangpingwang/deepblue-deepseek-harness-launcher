param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,
  [Parameter(Mandatory = $true)]
  [string]$OutputFile,
  [ValidateSet('online', 'offline')]
  [string]$Edition = 'offline'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDirectory = Join-Path $projectRoot 'release'
$electronBuilder = Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd'
$sourceFull = [IO.Path]::GetFullPath($SourceDirectory)
$releaseFull = [IO.Path]::GetFullPath($releaseDirectory + [IO.Path]::DirectorySeparatorChar)
$outputFull = [IO.Path]::GetFullPath($OutputFile)
$temporaryOutput = Join-Path $releaseDirectory ".nsis-$Edition"

if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) {
  throw "Packaged Windows directory not found: $sourceFull"
}
if (-not (Test-Path -LiteralPath $electronBuilder -PathType Leaf)) {
  throw "electron-builder executable not found: $electronBuilder"
}
if (-not $outputFull.StartsWith($releaseFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer output must stay inside the release directory.'
}
if ([IO.Path]::GetExtension($outputFull) -ne '.exe') {
  throw 'Installer output must use the .exe extension.'
}

$artifactName = [IO.Path]::GetFileName($outputFull)
if (Test-Path -LiteralPath $temporaryOutput) {
  Remove-Item -LiteralPath $temporaryOutput -Recurse -Force
}
New-Item -ItemType Directory -Path $temporaryOutput | Out-Null

try {
  & $electronBuilder `
    --win nsis `
    --x64 `
    --prepackaged $sourceFull `
    "--config.directories.output=$temporaryOutput" `
    "--config.artifactName=$artifactName"
  if ($LASTEXITCODE -ne 0) {
    throw "NSIS failed to create the $Edition installer (exit code $LASTEXITCODE)."
  }

  $builtInstaller = Join-Path $temporaryOutput $artifactName
  if (-not (Test-Path -LiteralPath $builtInstaller -PathType Leaf)) {
    throw "NSIS installer was not created: $builtInstaller"
  }
  if (Test-Path -LiteralPath $outputFull) {
    Remove-Item -LiteralPath $outputFull -Force
  }
  Move-Item -LiteralPath $builtInstaller -Destination $outputFull
} finally {
  Remove-Item -LiteralPath $temporaryOutput -Recurse -Force -ErrorAction SilentlyContinue
}

$installerInfo = Get-Item -LiteralPath $outputFull
Write-Host "Created $Edition one-click installer: $outputFull"
Write-Host "Bytes: $($installerInfo.Length)"
