param(
  [string]$SevenZipPath = $env:ELECTRON_BUILDER_7ZIP_PATH,
  [string]$MakeNsisPath = $env:DSH_MAKENSIS_PATH,
  [string]$NsisPluginsPath = $env:DSH_NSIS_PLUGINS_PATH,
  [string]$IconPath = $env:DSH_INSTALLER_ICON_PATH,
  [string]$CscPath = $env:DSH_CSC_PATH
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$sourceRoot = Join-Path $releaseRoot 'win-unpacked'
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.+-]+)?$') { throw 'Invalid launcher package version.' }
$executable = [string]$package.build.productName + '.exe'
if ($executable -match '[\\/]' -or $executable -eq '.exe') { throw 'Invalid launcher product name.' }
$output = Join-Path $releaseRoot "deepblue-deepseek-harness-launcher-$version-win-x64-offline.exe"

function Require-File([string]$file, [string]$label) {
  if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "$label missing: $file" }
  return [IO.Path]::GetFullPath($file)
}

function Cached-File([string]$directory, [string]$name) {
  if (Test-Path -LiteralPath $directory -PathType Container) {
    return Get-ChildItem -LiteralPath $directory -Recurse -Filter $name -File | Select-Object -First 1 -ExpandProperty FullName
  }
}

function File-Sha256([string]$file) {
  $stream = [IO.File]::OpenRead($file)
  try {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
  } finally { $stream.Dispose() }
}

function Escape-Nsis([string]$value) {
  return $value.Replace('$', '$$').Replace('"', '$\"')
}

# A pruned online shell is insufficient for a fully downloaded kernel update.
# These checks only inspect the known runtime entry points; no dependency is rebuilt.
$requiredPackageFiles = @(
  $executable,
  'resources\app\out\main\index.js',
  'resources\app\out\renderer\index.html',
  'resources\app\out\agent-host\module.json',
  'resources\app\node_modules\node\bin\node.exe',
  'resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js',
  'resources\app\node_modules\pnpm\bin\pnpm.cjs',
  'resources\resources\runtime-modules.generated.json'
)
foreach ($relative in $requiredPackageFiles) {
  $null = Require-File (Join-Path $sourceRoot $relative) 'Complete offline package entry'
}
$packagedManifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$packagedManifest.version -ne $version) { throw 'Packaged launcher version differs from package.json; rebuild the reviewed native package first.' }

if (-not $SevenZipPath) { $SevenZipPath = Cached-File (Join-Path $projectRoot 'build-cache\7zip@1.0.0') '7za.exe' }
if (-not $MakeNsisPath) { $MakeNsisPath = Cached-File (Join-Path $projectRoot 'build-cache\nsis-3.0.4.1') 'makensis.exe' }
if (-not $NsisPluginsPath) {
  $resources = Join-Path $projectRoot 'build-cache\nsis-resources-3.4.1'
  if (Test-Path -LiteralPath $resources -PathType Container) {
    $NsisPluginsPath = Get-ChildItem -LiteralPath $resources -Recurse -Directory -Filter 'x86-unicode' |
      Where-Object { $_.Parent.Name -eq 'plugins' } | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $IconPath) { $IconPath = Join-Path $releaseRoot '.icon-ico\icon.ico' }
if (-not $CscPath) { $CscPath = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' }
$sevenZip = Require-File $SevenZipPath '7za.exe (SevenZipPath/ELECTRON_BUILDER_7ZIP_PATH)'
$makeNsis = Require-File $MakeNsisPath 'makensis.exe (MakeNsisPath/DSH_MAKENSIS_PATH)'
$icon = Require-File $IconPath 'Installer icon'
$csc = Require-File $CscPath 'C# compiler'
$hashVerifierSource = Require-File (Join-Path $PSScriptRoot 'bootstrap\HashVerifier.cs') 'Existing hash verifier source'
$installerSource = Require-File (Join-Path $PSScriptRoot 'bootstrap\installer.nsi') 'Shared atomic installer source'
if (-not $NsisPluginsPath -or -not (Test-Path -LiteralPath $NsisPluginsPath -PathType Container)) { throw 'NSIS Unicode plugins missing (NsisPluginsPath/DSH_NSIS_PLUGINS_PATH).' }
$pluginRoot = [IO.Path]::GetFullPath($NsisPluginsPath)

# The archive and include remain internal build inputs. Only the versioned EXE
# is included in the four-artifact publication plan. Keep prior inputs for diagnosis.
$buildRoot = Join-Path $releaseRoot ('.offline-build-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$archive = Join-Path $buildRoot 'complete-launcher.7z'
$include = Join-Path $buildRoot 'offline-release.nsh'
$verifier = Join-Path $buildRoot 'HashVerifier.exe'
$stagedInstaller = Join-Path $buildRoot 'complete-offline.next.exe'

& $sevenZip 'a' '-t7z' '-mx=9' '-mmt=on' $archive (Join-Path $sourceRoot '*')
if ($LASTEXITCODE -ne 0) { throw "Complete offline archive failed ($LASTEXITCODE)." }
$null = Require-File $archive 'Complete offline archive'
$archiveInfo = Get-Item -LiteralPath $archive
if ($archiveInfo.Length -le 0) { throw 'Complete offline archive is empty.' }
$archiveSha256 = File-Sha256 $archive

& $csc /nologo /target:exe /optimize+ /platform:anycpu /out:$verifier $hashVerifierSource
if ($LASTEXITCODE -ne 0) { throw "Hash verifier compilation failed ($LASTEXITCODE)." }
$null = Require-File $verifier 'Compiled hash verifier'
$lines = @(
  "!define SHELL_VERSION `"$(Escape-Nsis $version)`"",
  "!define SHELL_EXECUTABLE `"$(Escape-Nsis $executable)`"",
  "!define SHELL_SHA256 `"$archiveSha256`"",
  "!define SHELL_SIZE `"$($archiveInfo.Length)`"",
  '!define SHELL_URL_GITHUB ""',
  '!define SHELL_URL_OSS ""',
  '!macro DownloadGiteeParts',
  '  StrCpy $DownloadStatus "PENDING"',
  '!macroend'
)
Set-Content -LiteralPath $include -Value $lines -Encoding UTF8

$previousNsisDir = $env:NSISDIR
$nsisDirectory = Split-Path -Parent $makeNsis
if ((Split-Path -Leaf $nsisDirectory) -ieq 'Bin') { $nsisDirectory = Split-Path -Parent $nsisDirectory }
try {
  $env:NSISDIR = $nsisDirectory
  & $makeNsis '/INPUTCHARSET' 'UTF8' '/DOFFLINE_SHELL' `
    "/DOFFLINE_SHELL_ARCHIVE=$archive" "/DPLUGIN_ROOT=$pluginRoot" `
    "/DRELEASE_INCLUDE=$include" "/DOUTPUT_FILE=$stagedInstaller" `
    "/DHASH_VERIFIER_EXE=$verifier" "/DSEVEN_ZIP_EXE=$sevenZip" `
    "/DAPP_ICON=$icon" $installerSource
  if ($LASTEXITCODE -ne 0) { throw "Offline NSIS build failed ($LASTEXITCODE)." }
} finally { $env:NSISDIR = $previousNsisDir }
$null = Require-File $stagedInstaller 'Complete offline installer'
$installerInfo = Get-Item -LiteralPath $stagedInstaller
if ($installerInfo.Length -le 0) { throw 'Complete offline installer is empty.' }
$installerSha256 = File-Sha256 $stagedInstaller

# Staging and destination share the release volume. An unsuccessful compile
# never deletes or truncates the previous complete artifact.
if (Test-Path -LiteralPath $output -PathType Leaf) { [IO.File]::Replace($stagedInstaller, $output, (Join-Path $buildRoot 'previous-offline.exe')) }
else { [IO.File]::Move($stagedInstaller, $output) }
[pscustomobject]@{
  version = $version; edition = 'offline'; outputFile = $output
  sha256 = $installerSha256; size = $installerInfo.Length
  archiveFile = $archive; archiveSha256 = $archiveSha256; archiveSize = $archiveInfo.Length
} | ConvertTo-Json
