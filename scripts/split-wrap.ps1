<#
  split-wrap.ps1 — separa el envoltorio de una caja (contraportada | lomo | portada) en los ficheros que
  Boxshelf espera dentro de la carpeta covers\.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\split-wrap.ps1 -Path "C:\ruta\sonic-colors.jpg" -Base "Sonic Colors"

  Opciones:
    -Base "Nombre"    nombre del juego tal y como se llama el fichero de ROM, sin extensión
                      (por defecto, el nombre del envoltorio sin extensión)
    -OutDir "C:\..."  carpeta de salida (por defecto, la del envoltorio)
    -SpineWidth 56    ancho del lomo en píxeles; úsalo si la detección automática se equivoca
    -Flip             el envoltorio es portada | lomo | contraportada (por defecto: contraportada | lomo | portada)
    -Inset 0          píxeles a recortar hacia dentro en cada pliegue (por defecto 2% del lomo)
    -DryRun           solo mide y cuenta lo que haría, sin escribir nada

  Escribe:
    <Base>.png          portada
    <Base>-spine.png    lomo
    <Base>-back.png     contraportada
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Base = "",
  [string]$OutDir = "",
  [int]$SpineWidth = 0,
  [switch]$Flip,
  [int]$Inset = -1,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$full = (Resolve-Path -LiteralPath $Path).Path
if (-not $Base) { $Base = [System.IO.Path]::GetFileNameWithoutExtension($full) }
if (-not $OutDir) { $OutDir = [System.IO.Path]::GetDirectoryName($full) }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# System.Drawing no sabe leer WebP (y a veces ni un PNG renombrado): si falla, se decodifica con WIC y se
# copia a un Bitmap normal, así el resto del script no cambia.
$bmp = $null
try { $bmp = [System.Drawing.Bitmap]::FromFile($full) } catch { $bmp = $null }
if (-not $bmp) {
  try {
    Add-Type -AssemblyName PresentationCore
    $uri = New-Object System.Uri($full)
    $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($uri,
      [System.Windows.Media.Imaging.BitmapCreateOptions]::None,
      [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
    $frame = $dec.Frames[0]
    $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($frame,
      [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $w = $conv.PixelWidth; $h = $conv.PixelHeight
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $r0 = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $dst = $bmp.LockBits($r0, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $buf = New-Object byte[] ($dst.Stride * $h)
    $conv.CopyPixels([System.Windows.Int32Rect]::Empty, $buf, $dst.Stride, 0)
    [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $dst.Scan0, $buf.Length)
    $bmp.UnlockBits($dst)
  } catch {
    throw "No se pudo abrir la imagen '$Path'. Formatos válidos: PNG, JPG, BMP, GIF, WebP. Detalle: $($_.Exception.Message)"
  }
}
$W = $bmp.Width; $H = $bmp.Height
if ($W -lt $H * 1.05) {
  $bmp.Dispose()
  throw "No parece un envoltorio: $($W)x$($H). Se espera claramente más ancho que alto (portada + lomo + contraportada)."
}

# --- píxeles a memoria (BGRA) para medir columnas rápido ---
$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $H)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)

$y0 = [int]($H * 0.06); $y1 = [int]($H * 0.94)
$ystep = [Math]::Max(1, [int]($H / 400))
# Un pliegue no es una línea de 1 px: es un salto de 3-4 px (sombra + cambio de color). Se mide la diferencia
# entre la columna x y la x-4; con 1 px el pliegue se pierde entre el dibujo de la carátula.
$K = 4
$edge = New-Object 'double[]' $W
for ($x = $K; $x -lt $W; $x++) {
  $e = 0.0
  for ($y = $y0; $y -lt $y1; $y += $ystep) {
    $i = $y * $stride + $x * 4; $j = $i - $K * 4
    $e += [Math]::Abs([int]$bytes[$i] - [int]$bytes[$j]) +
          [Math]::Abs([int]$bytes[$i + 1] - [int]$bytes[$j + 1]) +
          [Math]::Abs([int]$bytes[$i + 2] - [int]$bytes[$j + 2])
  }
  $edge[$x] = $e
}

# --- el lomo: dos pliegues verticales, casi simétricos ---
if ($SpineWidth -gt 0) {
  $s = $SpineWidth
  $L = [int](($W - $s) / 2)
} else {
  # El lomo de una caja de juego mide entre el 5% y el 16% del alto de la caja (Switch 5.9%, DVD 7.4%, DS 11.6%)
  # y las dos tapas miden prácticamente lo mismo. Si con esa banda no hay nada, se abre al 3%-25%.
  $bands = @(@(0.05, 0.16), @(0.03, 0.25))
  $cands = @()
  foreach ($band in $bands) {
    $minS = [Math]::Max(6, [int]($H * $band[0]))
    $maxS = [Math]::Max($minS + 1, [int]($H * $band[1]))
    $tol = [Math]::Max(2, [int]($W * 0.02))
    for ($ss = $minS; $ss -le $maxS; $ss++) {
      for ($off = -$tol; $off -le $tol; $off++) {
        $candL = [int](($W - $ss) / 2 + $off); $candR = $candL + $ss
        if ($candL -lt $K + 1 -or $candR -ge $W) { continue }
        # los dos cortes tienen que ser máximos locales: un pliegue, no una línea del dibujo
        $ok = $true
        foreach ($c in @($candL, $candR)) {
          for ($k = -4; $k -le 4; $k++) {
            $q = $c + $k
            if ($q -gt $K -and $q -lt $W -and $edge[$q] -gt $edge[$c]) { $ok = $false; break }
          }
          if (-not $ok) { break }
        }
        if (-not $ok) { continue }
        $cands += [pscustomobject]@{ L = $candL; R = $candR; s = $ss; score = $edge[$candL] + $edge[$candR] }
      }
    }
    if ($cands.Count) { break }
  }
  if (-not $cands.Count) { throw "No se encontró el lomo. Repite con -SpineWidth <píxeles>." }
  $bestScore = ($cands | Measure-Object -Property score -Maximum).Maximum
  # Entre cortes casi igual de buenos, el lomo MÁS ANCHO: el dibujo de dentro del lomo deja líneas más finas.
  $pick = $cands | Where-Object { $_.score -ge $bestScore * 0.8 } |
    Sort-Object -Property @{ Expression = 's'; Descending = $true }, @{ Expression = 'score'; Descending = $true } |
    Select-Object -First 1
  $L = $pick.L - [int]($K / 2); $s = $pick.s   # el pico está al final del salto: el pliegue empieza 2 px antes
}
$R = $L + $s

if ($Inset -lt 0) { $Inset = [Math]::Max(1, [int]($s * 0.02)) }
$spineL = $L + $Inset; $spineR = $R - $Inset
if ($spineR - $spineL -lt 2) { throw "El lomo detectado es demasiado estrecho ($($s) px). Prueba -SpineWidth." }

$frontW = $W - $R
$backW = $L
$ratioFront = [Math]::Round($frontW / $H, 3)
$ratioSpine = [Math]::Round($s / $H, 3)

"Imagen:        {0}x{1}" -f $W, $H
"Lomo:          x={0}..{1}  ({2} px, {3:P1} del ancho)" -f $L, $R, $s, ($s / $W)
"Portada:       {0} px  (ancho/alto = {1})" -f $frontW, $ratioFront
"Contraportada: {0} px" -f $backW
if ([Math]::Abs(($L + $R) / 2 - $W / 2) -gt ($W * 0.05)) { "AVISO: el lomo no está centrado; revisa el resultado o usa -SpineWidth." }
if ([Math]::Abs($frontW - $backW) -gt ($W * 0.08)) { "AVISO: portada y contraportada miden muy distinto; puede que falte un trozo o el lomo esté mal." }

$parts = @()
if ($Flip) {
  $parts += @{ name = 'back'; x = $spineR; w = $W - $spineR }
  $parts += @{ name = 'front'; x = 0; w = $L }
} else {
  $parts += @{ name = 'front'; x = $spineR; w = $W - $spineR }
  $parts += @{ name = 'back'; x = 0; w = $L }
}
$parts += @{ name = 'spine'; x = $spineL; w = $spineR - $spineL }

foreach ($p in $parts) {
  $suffix = switch ($p.name) { 'front' { '' } 'back' { '-back' } 'spine' { '-spine' } }
  $dest = Join-Path $OutDir ($Base + $suffix + '.png')
  if ($p.w -le 0) { "SALTADO $($p.name): ancho 0"; continue }
  if ($DryRun) { "haría  {0,-12} {1,5}x{2}  ->  {3}" -f $p.name, $p.w, $H, $dest; continue }
  $crop = New-Object System.Drawing.Rectangle $p.x, 0, $p.w, $H
  $piece = $bmp.Clone($crop, $bmp.PixelFormat)
  $piece.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $piece.Dispose()
  "escrito {0,-12} {1,5}x{2}  ->  {3}" -f $p.name, $p.w, $H, $dest
}

$bmp.Dispose()
if (-not $DryRun) {
  ""
  if ((Split-Path -Leaf $OutDir).ToLower() -eq 'covers') {
    "Ya están en la carpeta covers\ de ese sistema: reinicia Boxshelf (o entra y sale del estante) y salen."
  } else {
    "Cópialos a la carpeta covers\ de ese sistema (junto a las ROMs) con el nombre del fichero del juego."
  }
  "Para el cartucho/discos: <Base>-disc.png si algún día lo tienes."
}
