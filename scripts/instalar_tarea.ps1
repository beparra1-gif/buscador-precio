# Registra (o reemplaza) la tarea programada de Windows que corre
# actualizar_stock.py todos los días a las 08:45 — el archivo de stock se
# regenera a las 8:00 y se deja margen para que OneDrive/SharePoint lo sincronice.
#
# Uso (PowerShell, sin necesidad de administrador):
#   powershell -ExecutionPolicy Bypass -File scripts\instalar_tarea.ps1
#
# La tarea corre con tu usuario y solo mientras tengas sesión iniciada en el PC.
# Si el PC está apagado a esa hora, corre apenas se encienda (StartWhenAvailable).

$ErrorActionPreference = 'Stop'
$carpeta = $PSScriptRoot
$script = Join-Path $carpeta 'actualizar_stock.py'
$log = Join-Path $carpeta 'actualizar_stock.log'
$python = (& python -c "import sys; print(sys.executable)").Trim()

if (-not (Test-Path (Join-Path $carpeta 'stock_config.json'))) {
    throw "Falta scripts\stock_config.json (copiar de stock_config.example.json y completar)"
}

$accion = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c `"`"$python`" `"$script`" >> `"$log`" 2>&1`"" `
    -WorkingDirectory $carpeta
$disparador = New-ScheduledTaskTrigger -Daily -At '08:45'
$opciones = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'Buscador Comercial - Actualizar Stock' `
    -Action $accion -Trigger $disparador -Settings $opciones `
    -Description 'Sube la ultima semana de stock por tienda al Apps Script del Buscador Comercial' `
    -Force | Out-Null

Write-Host "Tarea registrada. Log en: $log"
Write-Host "Probar ahora: Start-ScheduledTask -TaskName 'Buscador Comercial - Actualizar Stock'"
