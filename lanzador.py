"""Lanzador: levanta el servidor local y abre la interfaz en el navegador.

    python lanzador.py            # si ya está corriendo, solo abre el navegador
    python lanzador.py --reinicio # lo usa el actualizador: espera a que el anterior termine

En una instalación de Windows lo corre runtime\\AlignerTrimline.exe (pythonw con otro nombre),
sin consola: por eso la salida va a un archivo de registro.
"""
from __future__ import annotations

import os
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP = Path(__file__).resolve().parent
PROGRAMA = APP.parent
PUERTO = int(os.environ.get("TRIMLINE_PORT", "8790"))
URL = f"http://127.0.0.1:{PUERTO}/"
INSTALADA = APP.name == "app" and (PROGRAMA / "app-release.json").exists()


def carpeta_de_datos() -> Path:
    if os.environ.get("TRIMLINE_HOME"):
        return Path(os.environ["TRIMLINE_HOME"])
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "AlignerTrimline"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "aligner-trimline"


def corriendo() -> bool:
    try:
        with urllib.request.urlopen(URL + "api/version", timeout=2) as r:
            return b"aligner-trimline" in r.read()
    except OSError:
        return False


def abrir_cuando_responda() -> None:
    for _ in range(120):
        if corriendo():
            webbrowser.open(URL)
            return
        time.sleep(0.25)


def main() -> None:
    reinicio = "--reinicio" in sys.argv
    if reinicio:
        for _ in range(60):                     # el proceso anterior todavía está soltando el puerto
            if not corriendo():
                break
            time.sleep(0.25)
    elif corriendo():
        webbrowser.open(URL)
        return

    datos = carpeta_de_datos()
    datos.mkdir(parents=True, exist_ok=True)
    os.environ["TRIMLINE_HOME"] = str(datos)
    if INSTALADA or sys.stdout is None:
        registro = open(datos / "trimline.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stderr = registro
        # no quedarse parado en app\\: Windows no deja renombrar la carpeta de trabajo de un
        # proceso, y el actualizador renombra app\\
        os.chdir(PROGRAMA)

    sys.path.insert(0, str(APP / "server"))
    os.environ.setdefault("TRIMLINE_WEB", str(APP / "web"))
    from trimline.__main__ import main as servidor

    if not reinicio:
        threading.Thread(target=abrir_cuando_responda, daemon=True).start()
    # si la pestaña se cierra, el servidor se apaga solo a los pocos minutos
    servidor(["--port", str(PUERTO), "--autocierre", os.environ.get("TRIMLINE_AUTOCIERRE", "180")])


if __name__ == "__main__":      # imprescindible en Windows si algún día hay procesos hijos
    main()
