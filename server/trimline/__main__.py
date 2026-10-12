"""python -m trimline [--port 8000] [--host 127.0.0.1] [--abrir] [--autocierre SEGUNDOS]"""
from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from . import app as modulo


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="trimline")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--abrir", action="store_true", help="abrir el navegador al arrancar")
    ap.add_argument("--autocierre", type=float, default=0, help="apagarse tras N segundos sin la interfaz abierta")
    a = ap.parse_args(argv)
    servidor = uvicorn.Server(uvicorn.Config(modulo.app, host=a.host, port=a.port, log_level="info"))
    modulo.estado["servidor"] = servidor
    if a.autocierre > 0:
        modulo.vigilar(a.autocierre)
    if a.abrir:
        threading.Timer(1.0, webbrowser.open, [f"http://127.0.0.1:{a.port}/"]).start()
    servidor.run()


if __name__ == "__main__":
    main()
