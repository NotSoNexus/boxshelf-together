<#
  pin-boxshelf.ps1 — crea el acceso directo de Boxshelf con su icono y lo deja anclado en la barra de tareas
  y en el menú Inicio de Windows (para el usuario actual, sin permisos de administrador).

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts\pin-boxshelf.ps1

  Qué hace:
    1. Boxshelf.lnk en la carpeta del proyecto, apuntando a electron.exe con el proyecto como argumento
       (así no se abre ninguna ventana de consola, y Windows sí deja anclarlo).
    2. Copia ese .lnk a la carpeta de anclados de la barra de tareas.
    3. Copia ese .lnk al menú Inicio (Todos los programas).

  Si la barra de tareas no lo muestra al momento, cierra sesión y vuelve a entrar (o reinicia el Explorador).
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico  = Join-Path $root 'renderer\app-icon.ico'
$lnk  = Join-Path $root 'Boxshelf.lnk'

if (-not (Test-Path -LiteralPath $exe)) { throw "No encuentro electron.exe en $exe. Ejecuta antes 'npm install' en la carpeta del proyecto." }
if (-not (Test-Path -LiteralPath $ico)) { throw "No encuentro el icono en $ico. Genera el .ico con scripts\make-icon.ps1." }

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath       = $exe
$s.Arguments        = '"' + $root + '"'      # el proyecto: electron.exe <carpeta> arranca Boxshelf
$s.WorkingDirectory = $root
$s.IconLocation     = "$ico,0"
$s.Description      = 'Boxshelf'
$s.WindowStyle      = 1
$s.Save()
"acceso directo: $lnk"

# --- barra de tareas: es la carpeta de la que Windows lee los anclados ---
$taskbar = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if (Test-Path -LiteralPath $taskbar) {
  Copy-Item -LiteralPath $lnk -Destination (Join-Path $taskbar 'Boxshelf.lnk') -Force
  "barra de tareas: $taskbar\Boxshelf.lnk"
} else {
  "AVISO: no existe la carpeta de anclados de la barra de tareas; ancla Boxshelf.lnk a mano (botón derecho → Anclar a la barra de tareas)."
}

# --- menú Inicio: Todos los programas ---
$start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
if (Test-Path -LiteralPath $start) {
  Copy-Item -LiteralPath $lnk -Destination (Join-Path $start 'Boxshelf.lnk') -Force
  "menu Inicio:    ${start}\Boxshelf.lnk"
} else {
  "AVISO: no existe la carpeta del menú Inicio; copia Boxshelf.lnk a mano."
}

""
"Si la barra de tareas todavía no lo enseña, reinicia el Explorador:"
"  Stop-Process -Name explorer -Force    (Windows lo vuelve a abrir solo)"
