<#
  make-icon.ps1 — convierte un PNG cuadrado en un .ico con todos los tamaños que usa Windows
  (16, 24, 32, 48, 64, 128 y 256 px), para el icono de la ventana, del .exe y de los accesos directos.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
    powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1 -Path "renderer\app-icon.png" -Out "renderer\app-icon.ico"
#>
param(
  [string]$Path = "renderer\app-icon.png",
  [string]$Out = ""
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = (Resolve-Path -LiteralPath $Path).Path
if (-not $Out) { $Out = [System.IO.Path]::ChangeExtension($src, '.ico') }
$Out = [System.IO.Path]::GetFullPath($Out)

$bmp = [System.Drawing.Bitmap]::FromFile($src)
if ($bmp.Width -ne $bmp.Height) { $bmp.Dispose(); throw "El icono debe ser cuadrado: $($bmp.Width)x$($bmp.Height)." }

# cada tamaño se guarda como PNG dentro del .ico (Windows Vista y posteriores lo leen tal cual)
$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = @()
foreach ($s in $sizes) {
  $b = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($bmp, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += , @{ size = $s; bytes = $ms.ToArray() }
  $ms.Dispose(); $b.Dispose()
}
$bmp.Dispose()

# cabecera ICONDIR + una entrada ICONDIRENTRY por tamaño, y luego las imágenes
$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter $fs
try {
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)   # reservado, tipo 1 = icono, cuántos
  $offset = 6 + 16 * $frames.Count
  foreach ($f in $frames) {
    $dim = if ($f.size -ge 256) { 0 } else { $f.size }   # 0 significa 256 en el formato
    $bw.Write([Byte]$dim); $bw.Write([Byte]$dim); $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)                                   # planos, bits por píxel
    $bw.Write([UInt32]$f.bytes.Length); $bw.Write([UInt32]$offset)
    $offset += $f.bytes.Length
  }
  foreach ($f in $frames) { $bw.Write($f.bytes) }
} finally { $bw.Dispose(); $fs.Dispose() }

$k = [Math]::Round((Get-Item -LiteralPath $Out).Length / 1024, 1)
"escrito $Out  ($k KB, $($frames.Count) tamaños: $($sizes -join ', '))"
