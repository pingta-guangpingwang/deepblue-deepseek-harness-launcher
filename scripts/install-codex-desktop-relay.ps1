param([Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$ExecutorThreadId)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path $PSScriptRoot -Parent
$taskSource = Join-Path $taskRepo 'out\agent-host\native-companion.mjs'
if (!(Test-Path -LiteralPath $taskSource)) { throw 'Build agent-host first' }
$taskCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$taskRelay = Join-Path $taskCodexHome 'shenlan-desktop-relay'
$taskParentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$taskParent = Get-CimInstance Win32_Process -Filter "ProcessId=$taskParentId"
if ($taskParent.Name -ne 'codex.exe' -or $taskParent.CommandLine -notmatch 'app-server') { throw 'Run setup from the active Codex Desktop task' }
$taskNode = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$taskCodex = $taskParent.ExecutablePath
[void](New-Item -ItemType Directory -Path $taskRelay -Force)
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $taskRelay /inheritance:r /grant:r "*${taskSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict local bridge config to this Windows user' }
$taskBackup = Join-Path $taskRelay ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
[void](New-Item -ItemType Directory -Path $taskBackup)
foreach ($taskFile in @('settings.json','companion.mjs')) { if (Test-Path -LiteralPath (Join-Path $taskRelay $taskFile)) { Copy-Item -LiteralPath (Join-Path $taskRelay $taskFile) -Destination $taskBackup } }
if (Test-Path -LiteralPath (Join-Path $taskCodexHome 'config.toml')) { Copy-Item -LiteralPath (Join-Path $taskCodexHome 'config.toml') -Destination (Join-Path $taskBackup 'config.toml') }
Copy-Item -LiteralPath $taskSource -Destination (Join-Path $taskRelay 'companion.mjs') -Force
@{executor=$ExecutorThreadId;version=1} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $taskRelay 'settings.json') -Encoding utf8NoBOM
& $taskCodex mcp add shenlan-desktop-relay -- $taskNode (Join-Path $taskRelay 'companion.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed; backup preserved' }
$taskPriorParent = $env:SHENLAN_DESKTOP_PARENT
try {
  $env:SHENLAN_DESKTOP_PARENT = [string]$taskParentId
  Start-Process -FilePath $taskNode -ArgumentList @(('"' + (Join-Path $taskRelay 'companion.mjs') + '"'), '--background') -WindowStyle Hidden
} finally { $env:SHENLAN_DESKTOP_PARENT = $taskPriorParent }
Write-Output 'Registered local-only Codex Desktop bridge. Existing conversations were not restarted or modified.'
