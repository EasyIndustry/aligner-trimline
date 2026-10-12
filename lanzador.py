"""Lanzador: levanta el servidor local y abre la interfaz en el navegador.

    python lanzador.py            # si ya está corriendo, solo abre el navegador
    python lanzador.py --reinicio # lo usa el actualizador: espera a que el anterior termine

En una instalación de Windows lo corre runtime\\AlignerTrimline.exe (pythonw con otro nombre),
sin consola: por eso la salida va a un archivo de registro, y un ícono en la bandeja muestra que
está abierto y deja cerrarlo.

El puerto es el primero libre desde el 8000 (o TRIMLINE_PORT). Queda anotado en servidor.json,
en la carpeta de datos: así otro lanzamiento encuentra al que ya corre, y el actualizador
vuelve a arrancar en el mismo puerto (la pestaña abierta se recarga sola).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP = Path(__file__).resolve().parent
PROGRAMA = APP.parent
DESDE, HASTA = 8000, 8100
INSTALADA = APP.name == "app" and (PROGRAMA / "app-release.json").exists()


def carpeta_de_datos() -> Path:
    if os.environ.get("TRIMLINE_HOME"):
        return Path(os.environ["TRIMLINE_HOME"])
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "AlignerTrimline"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "aligner-trimline"


def url(puerto: int) -> str:
    return f"http://127.0.0.1:{puerto}/"


def corriendo(puerto: int) -> bool:
    """¿Hay un aligner-trimline atendiendo en ese puerto?"""
    try:
        with urllib.request.urlopen(url(puerto) + "api/version", timeout=2) as r:
            return b"aligner-trimline" in r.read()
    except OSError:
        return False


def libre(puerto: int) -> bool:
    """¿Lo puede tomar el servidor? Con el mismo criterio que uvicorn: fuera de Windows acepta un
    puerto recién soltado (TIME_WAIT); en Windows SO_REUSEADDR dejaría robar uno ocupado."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", puerto))
        except OSError:
            return False
    return True


def anotado(datos: Path) -> int | None:
    """El puerto del último servidor que arrancó, si quedó anotado."""
    try:
        return int(json.loads((datos / "servidor.json").read_text(encoding="utf-8"))["puerto"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def elegir_puerto(datos: Path, reinicio: bool = False) -> int:
    if os.environ.get("TRIMLINE_PORT"):
        return int(os.environ["TRIMLINE_PORT"])
    previo = anotado(datos)
    if reinicio and previo:
        for _ in range(60):                     # el proceso anterior todavía está soltando el puerto
            if libre(previo):
                return previo
            time.sleep(0.25)
    for puerto in range(DESDE, HASTA):
        if libre(puerto):
            return puerto
    raise OSError(f"no hay ningún puerto libre entre {DESDE} y {HASTA - 1}")


def abrir_cuando_responda(puerto: int) -> None:
    for _ in range(120):
        if corriendo(puerto):
            webbrowser.open(url(puerto))
            return
        time.sleep(0.25)


def main() -> None:
    reinicio = "--reinicio" in sys.argv
    datos = carpeta_de_datos()
    datos.mkdir(parents=True, exist_ok=True)
    previo = int(os.environ["TRIMLINE_PORT"]) if os.environ.get("TRIMLINE_PORT") else anotado(datos)
    if not reinicio and previo and corriendo(previo):
        webbrowser.open(url(previo))
        return

    os.environ["TRIMLINE_HOME"] = str(datos)
    if INSTALADA or sys.stdout is None:
        registro = open(datos / "trimline.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stderr = registro
        # no quedarse parado en app\\: Windows no deja renombrar la carpeta de trabajo de un
        # proceso, y el actualizador renombra app\\
        os.chdir(PROGRAMA)

    puerto = elegir_puerto(datos, reinicio)
    (datos / "servidor.json").write_text(json.dumps({"puerto": puerto, "pid": os.getpid()}), encoding="utf-8")
    print(f"aligner-trimline en {url(puerto)}", flush=True)

    sys.path.insert(0, str(APP / "server"))
    os.environ.setdefault("TRIMLINE_WEB", str(APP / "web"))
    from trimline import app as aplicacion, bandeja
    from trimline.__main__ import main as servidor

    if not reinicio:
        threading.Thread(target=abrir_cuando_responda, args=(puerto,), daemon=True).start()
    sacar_icono = bandeja.iniciar(url(puerto), APP / "web" / "icono.ico", aplicacion.apagar)
    try:
        # si la pestaña se cierra, el servidor se apaga solo a los pocos minutos
        servidor(["--port", str(puerto), "--autocierre", os.environ.get("TRIMLINE_AUTOCIERRE", "180")])
    finally:
        sacar_icono()


if __name__ == "__main__":      # imprescindible en Windows si algún día hay procesos hijos
    main()
