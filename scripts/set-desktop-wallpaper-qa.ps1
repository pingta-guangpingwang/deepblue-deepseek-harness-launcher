param(
  [Parameter(Mandatory = $true)]
  [string] $WallpaperPath
)

$ErrorActionPreference = 'Stop'
$resolvedPath = (Resolve-Path -LiteralPath $WallpaperPath -ErrorAction Stop).Path

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DeepBlue.Windows.Qa {
  public static class DesktopWallpaper {
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Set(int action, int parameter, string value, int flags);

    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Get(int action, int parameter, StringBuilder value, int flags);
  }
}
'@

$spiSetDesktopWallpaper = 0x0014
$spiGetDesktopWallpaper = 0x0073
$flags = 0x0001 -bor 0x0002

if (-not [DeepBlue.Windows.Qa.DesktopWallpaper]::Set($spiSetDesktopWallpaper, 0, $resolvedPath, $flags)) {
  throw "SystemParametersInfoW failed with error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$actualPath = New-Object System.Text.StringBuilder 32768
if (-not [DeepBlue.Windows.Qa.DesktopWallpaper]::Get($spiGetDesktopWallpaper, $actualPath.Capacity, $actualPath, 0)) {
  throw "Windows did not return the active wallpaper path"
}

$actualResolved = [System.IO.Path]::GetFullPath($actualPath.ToString())
if (-not [string]::Equals($actualResolved, [System.IO.Path]::GetFullPath($resolvedPath), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Windows reported a different wallpaper path: $actualResolved"
}

[pscustomobject]@{ success = $true; actualPath = $actualResolved } | ConvertTo-Json -Compress
