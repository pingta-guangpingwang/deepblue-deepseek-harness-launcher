param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath,
  [string] $CompareTo,
  [double] $MinimumChangeRatio = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$target = [System.IO.Path]::GetFullPath($OutputPath)
$directory = [System.IO.Path]::GetDirectoryName($target)
[System.IO.Directory]::CreateDirectory($directory) | Out-Null

$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 700

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $shell.UndoMinimizeALL()
}

$changeRatio = $null
if ($CompareTo) {
  $baselinePath = (Resolve-Path -LiteralPath $CompareTo -ErrorAction Stop).Path
  $baseline = New-Object System.Drawing.Bitmap($baselinePath)
  $captured = New-Object System.Drawing.Bitmap($target)
  try {
    if ($baseline.Width -ne $captured.Width -or $baseline.Height -ne $captured.Height) {
      throw "Desktop capture dimensions changed from $($baseline.Width)x$($baseline.Height) to $($captured.Width)x$($captured.Height)"
    }
    $changed = 0
    $samples = 0
    $sampleStep = 12
    $sampleHeight = [Math]::Max(1, $captured.Height - 72)
    for ($y = 0; $y -lt $sampleHeight; $y += $sampleStep) {
      for ($x = 0; $x -lt $captured.Width; $x += $sampleStep) {
        $before = $baseline.GetPixel($x, $y)
        $after = $captured.GetPixel($x, $y)
        $distance = [Math]::Abs([int]$before.R - [int]$after.R) + [Math]::Abs([int]$before.G - [int]$after.G) + [Math]::Abs([int]$before.B - [int]$after.B)
        if ($distance -ge 45) { $changed += 1 }
        $samples += 1
      }
    }
    $changeRatio = $changed / [double]$samples
  } finally {
    $captured.Dispose()
    $baseline.Dispose()
  }
  if ($MinimumChangeRatio -gt 0 -and $changeRatio -lt $MinimumChangeRatio) {
    throw "Desktop pixels did not visibly change enough: $([Math]::Round($changeRatio * 100, 2))%"
  }
}

[pscustomobject]@{
  path = $target
  width = $bounds.Width
  height = $bounds.Height
  changeRatio = $changeRatio
} | ConvertTo-Json -Compress
