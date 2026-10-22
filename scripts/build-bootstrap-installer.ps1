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

$appBuilderManifest = Join-Path $projectRoot 'node_modules\app-builder-lib\package.json'
if (-not (Test-Path -LiteralPath $appBuilderManifest -PathType Leaf)) { throw 'app-builder-lib is required to resolve the installer build tools.' }
if (-not $env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE = Join-Path $projectRoot 'build-cache\electron-builder-cache' }
$verifiedNsisRoot = Join-Path $projectRoot 'build-cache\electron-builder-official\extracted\nsis-3.0.4.1'
$verifiedResourcesRoot = Join-Path $projectRoot 'build-cache\electron-builder-official\extracted\nsis-resources-3.4.1'
if (-not $env:ELECTRON_BUILDER_NSIS_DIR -and (Test-Path -LiteralPath $verifiedNsisRoot -PathType Container)) { $env:ELECTRON_BUILDER_NSIS_DIR = $verifiedNsisRoot }
if (-not $env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR -and (Test-Path -LiteralPath $verifiedResourcesRoot -PathType Container)) { $env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = $verifiedResourcesRoot }
$toolResolver = @'
const { createRequire } = require('node:module')
const path = require('node:path')
const appBuilderRequire = createRequire(process.argv[1])
const windows = appBuilderRequire('./out/toolsets/windows')
const sevenZip = appBuilderRequire('./out/toolsets/7zip')
Promise.all([sevenZip.getPath7za(), windows.getMakeNsisPath(undefined), windows.getNsisPluginsPath(undefined)])
  .then(([sevenZipPath, makeNsis, pluginsPath]) => console.log(JSON.stringify({ sevenZipPath, makeNsis, pluginsPath })))
  .catch(error => { console.error(error); process.exitCode = 1 })
'@
$toolOutput = & node -e $toolResolver $appBuilderManifest
if ($LASTEXITCODE -ne 0 -or -not $toolOutput) { throw 'app-builder-lib could not resolve the installer build tools.' }
try { $toolPaths = ($toolOutput | Select-Object -Last 1) | ConvertFrom-Json } catch { throw "Could not parse app-builder-lib tool paths: $toolOutput" }
$sevenZip = [string]$toolPaths.sevenZipPath
$makeNsis = [string]$toolPaths.makeNsis.path
$pluginRoot = Join-Path ([string]$toolPaths.pluginsPath) 'x86-unicode'
$appIcon = Join-Path $releaseRoot '.icon-ico\icon.ico'
foreach ($required in @($sevenZip, $makeNsis, $pluginRoot, $appIcon)) { if (-not (Test-Path -LiteralPath $required)) { throw "Build dependency missing: $required" } }

function Escape-Nsis([string]$value) { return $value.Replace('$', '$$').Replace('"', '$\"') }
$mirrors = @{}
foreach ($mirror in $generated.mirrors) { $mirrors[[string]$mirror.id] = [string]$mirror.url }
$giteeMirror = $generated.mirrors | Where-Object { [string]$_.id -eq 'gitee' } | Select-Object -First 1
$lines = @(
  "!define SHELL_VERSION `"$(Escape-Nsis ([string]$generated.version))`"",
  "!define SHELL_EXECUTABLE `"$(Escape-Nsis ([string]$generated.executable))`"",
  "!define SHELL_SHA256 `"$([string]$generated.sha256)`"",
  "!define SHELL_SIZE `"$([string]$generated.size)`"",
  "!define SHELL_URL_GITHUB `"$(Escape-Nsis $mirrors.github)`"",
  "!define SHELL_URL_OSS `"$(Escape-Nsis $mirrors.oss)`""
)
$giteePartLines = @('!macro DownloadGiteeParts')
$hasGiteeParts = $giteeMirror -and $giteeMirror.parts -and $giteeMirror.parts.Count -gt 0
if ($hasGiteeParts) {
  $giteePartLines += '  StrCpy $DownloadStatus "OK"'
} else {
  # Some Gitee repositories enforce a 1 GB quota and cannot accept the signed
  # runtime archive. Keep the bootstrap buildable and move directly to OSS.
  $giteePartLines += '  StrCpy $DownloadStatus "PENDING"'
}
$joinCommand = '"$PLUGINSDIR\HashVerifier.exe" --join "$PLUGINSDIR\launcher-shell.7z" "${SHELL_SHA256}" "${SHELL_SIZE}"'
$nsisShellVersion = '$' + '{SHELL_VERSION}'
for ($index = 0; $hasGiteeParts -and $index -lt $giteeMirror.parts.Count; $index++) {
  $part = $giteeMirror.parts[$index]
  $partNumber = $index + 1
  $partFile = "shell-part-{0:d3}" -f $partNumber
  $escapedPartUrl = Escape-Nsis ([string]$part.url)
  $giteePartLines += '  ${If} $DownloadStatus == "OK"'
  $giteePartLines += "    DetailPrint `"正在下载 Gitee 分片 $partNumber/$($giteeMirror.parts.Count)…`""
  $giteePartLines += "    inetc::get /USERAGENT `"DeepBlue-DeepSeek-Harness-Bootstrap/$nsisShellVersion`" /CONNECTTIMEOUT 8 /RECEIVETIMEOUT 15 `"$escapedPartUrl`" `"`$PLUGINSDIR\$partFile`" /END"
  $giteePartLines += '    Pop $DownloadStatus'
  $giteePartLines += '  ${EndIf}'
  $joinCommand += (' "$PLUGINSDIR\{0}" "{1}" "{2}"' -f $partFile, [string]$part.sha256, [string]$part.size)
}
if ($hasGiteeParts) {
  $giteePartLines += '  ${If} $DownloadStatus == "OK"'
  $giteePartLines += ('    ExecWait ''{0}'' $0' -f $joinCommand)
  $giteePartLines += '    ${If} $0 != 0'
  $giteePartLines += '      StrCpy $DownloadStatus "Gitee 分片校验失败（代码 $0）"'
  $giteePartLines += '    ${EndIf}'
  $giteePartLines += '  ${EndIf}'
}
$giteePartLines += '!macroend'
$lines += $giteePartLines
Set-Content -LiteralPath $include -Value $lines -Encoding UTF8

$previousNsisDir = $env:NSISDIR
if ($toolPaths.makeNsis.env.NSISDIR) { $env:NSISDIR = [string]$toolPaths.makeNsis.env.NSISDIR }
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
if ($null -eq $previousNsisDir) { Remove-Item Env:NSISDIR -ErrorAction SilentlyContinue } else { $env:NSISDIR = $previousNsisDir }

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
