# Capture the WSLg "Galaxy Downloader" window from Windows without raising or
# focusing it. PrintWindow(hdc, 2) renders the window's own backing store, so the
# shot is correct even when the window is behind other apps.
Add-Type -AssemblyName System.Drawing
$sig = @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -TypeDefinition $sig
# WSLg windows are owned by the msrdc host process, so match on the title only.
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "Galaxy Downloader*" } | Select-Object -First 1
if (-not $p) { Write-Output "NOTFOUND"; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][W]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$out = "$env:TEMP\app.png"
$bmp.Save($out)
Write-Output "$out ${w}x${ht}"
