$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$generatedPath = Join-Path $releaseRoot 'launcher-shell.generated.json'
$generated = Get-Content -LiteralPath $generatedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$buildRoot = Join-Path $releaseRoot '.bootstrap-build'
$verifier = Join-Path $buildRoot 'HashVerifier.exe'
$include = Join-Path $buildRoot 'bootstrap-release.nsh'
$output = Join-Path $releaseRoot 'deepblue-deepseek-harness-launcher-win-x64-online-bootstrap.exe'

if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Path $buildRoot | Out-Null

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'The .NET Framework C# compiler was not found.' }
& $csc /nologo /target:exe /optimize+ /platform:anycpu /out:$verifier (Join-Path $PSScriptRoot 'bootstrap\HashVerifier.cs')
if ($LASTEXITCODE -ne 0) { throw "Hash verifier compilation failed ($LASTEXITCODE)." }

$sevenZip = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'build-cache\7zip@1.0.0') -Recurse -Filter '7za.exe' -File | Select-Object -First 1 -ExpandProperty FullName
$nsisRoot = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'build-cache\nsis-3.0.4.1') -Directory | Where-Object Name -Like 'nsis-*' | Select-Object -First 1 -ExpandProperty FullName
$resourcesRoot = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'build-cache\nsis-resources-3.4.1') -Directory | Where-Object Name -Like 'nsis-resources-*' | Select-Object -First 1 -ExpandProperty FullName
$makeNsis = Join-Path $nsisRoot 'makensis.exe'
$pluginRoot = Join-Path $resourcesRoot 'plugins\x86-unicode'
$appIcon = Join-Path $releaseRoot '.icon-ico\icon.ico'
foreach ($required in @($sevenZip, $makeNsis, $pluginRoot, $appIcon)) { if (-not (Test-Path -LiteralPath $required)) { throw "Build dependency missing: $required" } }

function Escape-Nsis([string]$value) { return $value.Replace('$', '$$').Replace('"', '$\"') }
$mirrors = @{}
foreach ($mirror in $generated.mirrors) { $mirrors[[string]$mirror.id] = [string]$mirror.url }
$lines = @(
  "!define SHELL_VERSION `"$(Escape-Nsis ([string]$generated.version))`"",
  "!define SHELL_EXECUTABLE `"$(Escape-Nsis ([string]$generated.executable))`"",
  "!define SHELL_SHA256 `"$([string]$generated.sha256)`"",
  "!define SHELL_SIZE `"$([string]$generated.size)`"",
  "!define SHELL_URL_GITHUB `"$(Escape-Nsis $mirrors.github)`""
)
Set-Content -LiteralPath $include -Value $lines -Encoding UTF8

& $makeNsis `
  "/INPUTCHARSET" "UTF8" `
  "/DPLUGIN_ROOT=$pluginRoot" `
  "/DRELEASE_INCLUDE=$include" `
  "/DOUTPUT_FILE=$output" `
  "/DHASH_VERIFIER_EXE=$verifier" `
  "/DSEVEN_ZIP_EXE=$sevenZip" `
  "/DAPP_ICON=$appIcon" `
  (Join-Path $PSScriptRoot 'bootstrap\installer.nsi')
if ($LASTEXITCODE -ne 0) { throw "Bootstrap NSIS build failed ($LASTEXITCODE)." }

$info = Get-Item -LiteralPath $output
$stream = [IO.File]::OpenRead($output)
try {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
} finally { $stream.Dispose() }
Write-Host "Created lightweight online bootstrap: $output"
Write-Host "Bytes: $($info.Length)"
Write-Host "SHA256: $digest"
