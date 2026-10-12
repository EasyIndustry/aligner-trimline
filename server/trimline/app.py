"""El servidor local: sirve la interfaz y hace el cálculo pesado sobre las mallas.

El navegador se queda con lo liviano (rayo del mouse, arrastre, dibujo). Acá viven las mallas,
la generación de la curva, los keyframes y la exportación.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, actualizar, mallas, nombres, proyecto
from .exportar import EXPORTADORES, ORDEN_MAXILARES, exportar

WEB = Path(os.environ.get("TRIMLINE_WEB") or Path(__file__).resolve().parents[2] / "web")

app = FastAPI(title="aligner-trimline", version=__version__)

# El lanzador deja acá el servidor de uvicorn para poder apagarlo desde la interfaz.
estado = {"servidor": None, "ultimo_latido": None}


@app.middleware("http")
async def sin_cache(request: Request, call_next):
    respuesta = await call_next(request)
    if not request.url.path.startswith("/vendor/"):
        respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


def _error(e: Exception) -> HTTPException:
    return HTTPException(status_code=404 if isinstance(e, KeyError) else 422, detail=str(e).strip("'\""))


@app.get("/api/version")
def version() -> dict:
    return {"nombre": "aligner-trimline", "version": __version__}


@app.post("/api/mallas")
async def subir_malla(request: Request, nombre: str) -> dict:
    """Recibe el archivo tal cual (cuerpo crudo) y lo deja cargado e indexado."""
    try:
        malla = mallas.cargar(await request.body(), nombre)
    except Exception as e:  # noqa: BLE001  (un archivo que no es malla no tiene que tirar el server)
        raise HTTPException(status_code=422, detail=f"{nombre}: {e}") from None
    return {**malla.resumen(), "nombre": nombre, "archivo": nombres.interpretar(nombre)}


@app.get("/api/mallas/{ident}/bin")
def malla_binaria(ident: str) -> Response:
    try:
        return Response(mallas.obtener(ident).binario(), media_type="application/octet-stream")
    except KeyError as e:
        raise _error(e) from None


def _json_curva(r: dict) -> dict:
    return {
        "num": r["num"],
        "cerrada": r["cerrada"],
        "largo": round(r["largo"], 3),
        "tramos": [{
            "puntos": np.round(t["puntos"], 4).ravel().tolist(),
            "claves": np.round(t["claves"], 4).ravel().tolist(),
            "info": t["info"],
            "manijas": np.round(t["manijas"], 4).ravel().tolist(),
        } for t in r["tramos"]],
        "controladores": [{"id": c["id"], "tipo": c["tipo"], "clave": c["clave"],
                           "pos": np.round(c["pos"], 4).tolist()} for c in r["controladores"]],
    }


@app.post("/api/resolver")
def resolver(cuerpo: dict) -> dict:
    """Controladores y curva de los movimientos pedidos (o de todos) de un maxilar."""
    maxilar = cuerpo["maxilar"]
    nums = cuerpo.get("nums") or [m["num"] for m in maxilar["movimientos"]]
    try:
        return {"movimientos": {
            num: _json_curva(proyecto.resolver(maxilar, num, n=int(cuerpo.get("n") or 300))) for num in nums
        }}
    except (KeyError, ValueError, StopIteration) as e:
        raise _error(e) from None


@app.get("/api/exportadores")
def exportadores() -> dict:
    return {"exportadores": [{k: v for k, v in e.items() if k != "fn"} for e in EXPORTADORES.values()]}


@app.post("/api/exportar")
def exportar_trabajo(cuerpo: dict) -> dict:
    """Resuelve todas las curvas de todos los maxilares y las pasa al exportador pedido."""
    n = cuerpo.get("n")
    paso = cuerpo.get("paso")
    if not n and not paso:
        n = 500
    trabajo = {"id": str(cuerpo.get("id") or "caso").strip() or "caso", "maxilares": {}}
    try:
        for clave in ORDEN_MAXILARES:
            maxilar = (cuerpo.get("maxilares") or {}).get(clave)
            if not maxilar or not maxilar.get("movimientos") or not maxilar.get("controladores"):
                continue
            con_clave = set(proyecto.con_keyframe(maxilar))
            movs = []
            for m in maxilar["movimientos"]:
                r = proyecto.resolver(maxilar, m["num"], n=int(n) if n else None, paso=float(paso) if paso else None)
                if not r["cerrada"]:
                    raise ValueError(f"{clave} {m['num']}: la curva no está cerrada (faltan vestibulares, linguales o los dos extremos)")
                orden = {c["id"]: c for c in r["controladores"]}
                movs.append({
                    "num": m["num"], "cerrada": True, "curva": r["tramos"][0]["puntos"],
                    "controladores": [orden[i["id"]] for i in r["tramos"][0]["info"] if i["clase"] == "cresta"],
                    "tiene_clave": m["num"] in con_clave,
                })
            trabajo["maxilares"][clave] = movs
        if not trabajo["maxilares"]:
            raise ValueError("no hay ninguna curva para exportar")
        archivos = exportar(cuerpo.get("formato") or "pts", trabajo, cuerpo.get("opciones"))
    except (KeyError, ValueError, StopIteration) as e:
        raise _error(e) from None
    return {"archivos": archivos}


@app.post("/api/latido")
def latido() -> dict:
    estado["ultimo_latido"] = time.monotonic()
    return {"ok": True}


@app.post("/api/cerrar")
def cerrar() -> dict:
    apagar()
    return {"ok": True}


def apagar() -> None:
    servidor = estado["servidor"]
    if servidor is not None:
        servidor.should_exit = True


def vigilar(segundos: float) -> None:
    """Apaga el servidor cuando la interfaz deja de dar señales: no queda un proceso colgado."""
    def bucle():
        while True:
            time.sleep(5)
            ultimo = estado["ultimo_latido"]
            if ultimo is not None and time.monotonic() - ultimo > segundos:
                apagar()
                return
    threading.Thread(target=bucle, daemon=True).start()


@app.get("/api/actualizacion")
def actualizacion(buscar: bool = False) -> dict:
    """Qué versión está puesta y, con buscar=true, qué releases hay en GitHub."""
    return {**actualizar.estado(buscar), "version": __version__}


@app.post("/api/actualizacion/instalar")
def actualizacion_instalar(cuerpo: dict) -> dict:
    try:
        res = actualizar.instalar(str(cuerpo.get("tag") or ""))
    except Exception as e:  # noqa: BLE001  (red, disco o release mal armado: se le cuenta al usuario)
        raise HTTPException(status_code=422, detail=str(e)) from None
    reiniciar()
    return res


@app.post("/api/actualizacion/revertir")
def actualizacion_revertir() -> dict:
    try:
        res = actualizar.revertir()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(e)) from None
    reiniciar()
    return res


def reiniciar() -> None:
    """Arranca el lanzador de la versión nueva y apaga este proceso un momento después."""
    lanzador = actualizar.APP / "lanzador.py"
    opciones = {}
    if sys.platform == "win32":
        opciones["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        opciones["start_new_session"] = True
    subprocess.Popen([sys.executable, str(lanzador), "--reinicio"], cwd=str(actualizar.PROGRAMA), **opciones)  # noqa: S603
    threading.Timer(0.5, apagar).start()


@app.get("/")
def raiz() -> RedirectResponse:
    return RedirectResponse("/index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
