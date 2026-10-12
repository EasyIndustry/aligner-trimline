"""Diálogos nativos que abre el servidor, para lo que el navegador no deja hacer.

Chrome y Edge no dejan elegir con su selector carpetas que consideran del sistema (la del
usuario, el Escritorio, Descargas, algunas unidades de red). Elegir la carpeta acá y escribir
desde el servidor no tiene esa restricción.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

# FolderBrowserDialog de .NET, colgado de una ventana invisible "siempre encima": si no, se abre
# detrás del navegador. La carpeta inicial llega por variable de entorno (sin problemas de comillas).
_POWERSHELL = r"""
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dueno = New-Object System.Windows.Forms.Form
$dueno.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:TRIMLINE_TITULO
$d.ShowNewFolderButton = $true
if ($env:TRIMLINE_INICIAL -and (Test-Path -LiteralPath $env:TRIMLINE_INICIAL)) { $d.SelectedPath = $env:TRIMLINE_INICIAL }
if ($d.ShowDialog($dueno) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
$dueno.Dispose()
"""


class SinDialogo(RuntimeError):
    """No hay cómo mostrar un diálogo en este sistema."""


def elegir_carpeta(inicial: str | None = None, titulo: str = "Elegí la carpeta") -> str | None:
    """Muestra el diálogo y devuelve la carpeta elegida, o None si se canceló."""
    if sys.platform == "win32":
        entorno = {**os.environ, "TRIMLINE_INICIAL": inicial or "", "TRIMLINE_TITULO": titulo}
        r = subprocess.run(  # noqa: S603
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", _POWERSHELL],
            capture_output=True, env=entorno, creationflags=subprocess.CREATE_NO_WINDOW, check=False,
        )
        salida = r.stdout.decode("utf-8", errors="replace").strip()
    elif shutil.which("zenity"):
        orden = ["zenity", "--file-selection", "--directory", f"--title={titulo}"]
        if inicial:
            orden.append(f"--filename={inicial.rstrip('/')}/")
        r = subprocess.run(orden, capture_output=True, text=True, check=False)  # noqa: S603
        salida = r.stdout.strip()
    elif shutil.which("kdialog"):
        r = subprocess.run(["kdialog", "--title", titulo, "--getexistingdirectory", inicial or os.path.expanduser("~")],  # noqa: S603
                           capture_output=True, text=True, check=False)
        salida = r.stdout.strip()
    else:
        raise SinDialogo("no hay un diálogo de carpetas en este sistema: escribí la ruta a mano")
    return salida or None
