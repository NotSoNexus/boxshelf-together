@echo off
rem Arranca Boxshelf usando el Node portable de .tools\node (no hace falta instalar Node en el sistema).
rem   Mi Boxshelf.bat            -> pantalla completa
rem   Mi Boxshelf.bat ventana    -> en una ventana
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
if not exist node_modules (
  echo Instalando dependencias la primera vez. Tarda un par de minutos...
  call npm install
)
if /i "%~1"=="ventana" (
  call npm run windowed
) else (
  call npm start
)
