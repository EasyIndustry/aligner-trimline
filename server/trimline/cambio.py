"""Cambia la carpeta app/ por otra versión cuando el programa ya se cerró, y lo vuelve a abrir.

    <runtime>/AlignerTrimline.exe cambio.py --programa <carpeta> --modo instalar|revertir --tag T

Lo lanza el actualizador desde una copia fuera de app/ y enseguida se cierra el servidor. Así
nadie tiene nada abierto dentro de app/ cuando se renombra: Windows no deja renombrar una carpeta
mientras un proceso tiene un archivo abierto adentro (el servidor que corre, el ícono de la
bandeja), y el antivirus a veces la toma un momento. Por eso se reintenta un rato.

No importa nada del programa: tiene que poder correr con app/ en cualquier estado.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ESPERA = 60          # segundos reintentando: el servidor tarda en soltar todo; el antivirus, a veces más


def renombrar(origen: Path, destino: Path) -> None:
    limite = time.monotonic() + ESPERA
    while True:
        try:
            origen.rename(destino)
            return
        except OSError:
            if time.monotonic() > limite:
                raise
            time.sleep(0.5)


def cambiar(programa: Path, modo: str, tag: str | None) -> str:
    """Hace el cambio y devuelve qué versión quedó. Si no se puede, deja todo como estaba."""
    app, anterior, nueva = programa / "app", programa / "app.anterior", programa / "app.nueva"
    marca = programa / "app-release.json"
    try:
        previo = json.loads(marca.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previo = {}
    if modo == "instalar":
        if not nueva.is_dir():
            raise FileNotFoundError("no está la versión bajada (app.nueva)")
        shutil.rmtree(anterior, ignore_errors=True)
        renombrar(app, anterior)
        try:
            renombrar(nueva, app)
        except OSError:
            renombrar(anterior, app)                     # no se pudo: todo queda como estaba
            raise
        dato = {"tag": tag, "source": "actualizador", "previous_tag": previo.get("tag")}
    else:
        if not anterior.is_dir():
            raise FileNotFoundError("no hay una versión anterior guardada")
        aparte = programa / "app.cambio"
        shutil.rmtree(aparte, ignore_errors=True)
        renombrar(app, aparte)
        try:
            renombrar(anterior, app)
        except OSError:
            renombrar(aparte, app)
            raise
        renombrar(aparte, anterior)
        dato = {"tag": previo.get("previous_tag"), "source": "vuelta atrás", "previous_tag": previo.get("tag")}
    marca.write_text(json.dumps({**dato, "applied_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=1), encoding="utf-8")
    return str(dato["tag"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--programa", required=True, type=Path)
    ap.add_argument("--modo", choices=["instalar", "revertir"], required=True)
    ap.add_argument("--tag")
    ap.add_argument("--datos", type=Path, help="carpeta de datos: ahí queda el resultado")
    a = ap.parse_args()
    os.chdir(a.programa)                                 # no quedarse parado dentro de app/
    resultado = {"modo": a.modo, "cuando": time.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        resultado.update(ok=True, tag=cambiar(a.programa, a.modo, a.tag))
    except Exception as e:  # noqa: BLE001  (se anota y el programa vuelve a abrir igual)
        resultado.update(ok=False, error=f"{type(e).__name__}: {e}")
    if a.datos:
        try:
            a.datos.mkdir(parents=True, exist_ok=True)
            (a.datos / "actualizacion.json").write_text(json.dumps(resultado, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass
    # vuelve a abrir el programa: el nuevo si salió, el de antes si no
    opciones = {}
    if sys.platform == "win32":
        opciones["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        opciones["start_new_session"] = True
    subprocess.Popen([sys.executable, str(a.programa / "app" / "lanzador.py"), "--reinicio"],  # noqa: S603
                     cwd=str(a.programa), **opciones)


if __name__ == "__main__":
    main()
