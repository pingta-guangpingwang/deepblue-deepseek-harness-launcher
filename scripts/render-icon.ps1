Add-Type -AssemblyName System.Drawing

$size = 512
$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(11, 25, 42))

$blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(23, 105, 246))
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$ice = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(185, 221, 255))
$graphics.FillEllipse($blue, 72, 72, 368, 368)

$leftSail = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(236, 101)),
  (New-Object System.Drawing.Point(132, 326)),
  (New-Object System.Drawing.Point(236, 326))
)
$rightSail = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(265, 153)),
  (New-Object System.Drawing.Point(376, 322)),
  (New-Object System.Drawing.Point(265, 322))
)
$hull = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(112, 346)),
  (New-Object System.Drawing.Point(268, 379)),
  (New-Object System.Drawing.Point(409, 350)),
  (New-Object System.Drawing.Point(347, 396)),
  (New-Object System.Drawing.Point(268, 409)),
  (New-Object System.Drawing.Point(186, 390))
)
$graphics.FillPolygon($white, $leftSail)
$graphics.FillPolygon($ice, $rightSail)
$graphics.FillPolygon($white, $hull)

$target = Join-Path $PSScriptRoot '..\resources\icon.png'
$bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
$blue.Dispose()
$white.Dispose()
$ice.Dispose()
Write-Output $target
