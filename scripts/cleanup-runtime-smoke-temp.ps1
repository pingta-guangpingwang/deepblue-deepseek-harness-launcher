param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Paths)

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
Start-Sleep -Seconds 2

foreach ($candidate in $Paths) {
  $target = [IO.Path]::GetFullPath($candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $parent = [IO.Path]::GetDirectoryName($target)
  $leaf = [IO.Path]::GetFileName($target)
  if ($parent -ne $tempRoot -or $leaf -notlike 'deepblue-generated-modules-*') {
    throw "Refusing to clean an unexpected runtime smoke path: $target"
  }
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    try {
      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
      }
      break
    } catch {
      if ($attempt -eq 11) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}
