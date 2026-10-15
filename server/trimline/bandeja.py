"""El ícono en la bandeja del sistema (abajo a la derecha en Windows).

El programa no tiene ventana propia: el servidor corre sin consola y la interfaz es una pestaña
del navegador. El ícono muestra que está abierto y deja volver a la pestaña o cerrarlo del todo.

Va solo en Windows (o con TRIMLINE_BANDEJA=1): en Linux la bandeja depende del escritorio, y
desde una terminal se cierra con Ctrl+C.
"""
from __future__ import annotations

import os
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Callable


def iniciar(url: str, icono: Path, cerrar: Callable[[], None]) -> Callable[[], None]:
    """Pone el ícono y devuelve cómo sacarlo. `cerrar` apaga el servidor."""
    if sys.platform != "win32" and os.environ.get("TRIMLINE_BANDEJA") != "1":
        return lambda: None
    try:
        import pystray
        from PIL import Image
    except ImportError as e:
        print(f"sin ícono en la bandeja: {e}", flush=True)
        return lambda: None

    def salir(icon, _item) -> None:
        icon.stop()
        cerrar()

    # cargado entero y cerrado: Image.open deja el archivo abierto hasta usarlo, y un archivo
    # abierto dentro de app\ no deja renombrar la carpeta al actualizar
    with Image.open(icono) as im:
        imagen = im.copy()
    icon = pystray.Icon(
        "AlignerTrimline", imagen, "Aligner Trimline: línea de recorte",
        pystray.Menu(
            pystray.MenuItem("Abrir", lambda _i, _it: webbrowser.open(url), default=True),
            pystray.MenuItem("Cerrar el programa", salir),
        ),
    )

    def correr() -> None:
        try:
            icon.run()
        except Exception as e:  # noqa: BLE001  (sin bandeja el programa igual anda)
            print(f"sin ícono en la bandeja: {e}", flush=True)

    threading.Thread(target=correr, name="bandeja", daemon=True).start()
    return icon.stop
