"""Lanzador: levanta el servidor local y abre la interfaz en el navegador.

    python lanzador.py            # si ya está corriendo, solo abre el navegador (si es otra
                                  # versión, la cierra y arranca la instalada)
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
import re
import signal
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


def version_en(puerto: int) -> str | None:
    """La versión del aligner-trimline que atiende en ese puerto, o None si no hay ninguno."""
    try:
        with urllib.request.urlopen(url(puerto) + "api/version", timeout=2) as r:
            dato = json.loads(r.read())
    except (OSError, ValueError):
        return None
    return str(dato.get("version") or "?") if dato.get("nombre") == "aligner-trimline" else None


def corriendo(puerto: int) -> bool:
    """¿Hay un aligner-trimline atendiendo en ese puerto?"""
    return version_en(puerto) is not None


def version_instalada() -> str:
    """La versión del código que está en esta carpeta (sin importarlo: es solo leer un número)."""
    texto = (APP / "server" / "trimline" / "__init__.py").read_text(encoding="utf-8")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', texto)
    return m[1] if m else "?"


def cerrar_viejo(datos: Path, puerto: int) -> None:
    """Cierra un servidor de otra versión que quedó andando (por ejemplo, después de actualizar).

    Primero se le pide que se cierre; si no lo hace, se termina su proceso (el pid queda anotado
    en servidor.json). Así el ícono nunca abre una versión que ya no es la instalada.
    """
    try:
        urllib.request.urlopen(urllib.request.Request(url(puerto) + "api/cerrar", data=b"{}", method="POST",
                                                      headers={"Content-Type": "application/json"}), timeout=3).close()
    except OSError:
        pass
    for _ in range(40):
        if not corriendo(puerto):
            return
        time.sleep(0.25)
    try:
        pid = int(json.loads((datos / "servidor.json").read_text(encoding="utf-8"))["pid"])
        if pid != os.getpid():
            os.kill(pid, signal.SIGTERM)                # en Windows: TerminateProcess
    except (OSError, ValueError, KeyError, TypeError):
        pass
    for _ in range(20):
        if not corriendo(puerto):
            return
        time.sleep(0.25)


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
    abrir = not reinicio
    datos = carpeta_de_datos()
    datos.mkdir(parents=True, exist_ok=True)
    previo = int(os.environ["TRIMLINE_PORT"]) if os.environ.get("TRIMLINE_PORT") else anotado(datos)
    if not reinicio and previo:
        andando = version_en(previo)
        if andando is not None and andando == version_instalada():
            webbrowser.open(url(previo))
            return
        if andando is not None:                         # quedó andando otra versión: se la cambia
            cerrar_viejo(datos, previo)
            reinicio = True                             # y se vuelve al mismo puerto
            abrir = True

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

    if abrir:
        threading.Thread(target=abrir_cuando_responda, args=(puerto,), daemon=True).start()
    sacar_icono = bandeja.iniciar(url(puerto), APP / "web" / "icono.ico", aplicacion.apagar)
    try:
        # si la pestaña se cierra, el servidor se apaga solo a los pocos minutos
        servidor(["--port", str(puerto), "--autocierre", os.environ.get("TRIMLINE_AUTOCIERRE", "180")])
    finally:
        sacar_icono()


if __name__ == "__main__":      # imprescindible en Windows si algún día hay procesos hijos
    main()
