"""El servidor local: sirve la interfaz y hace el cálculo pesado sobre las mallas.

El navegador se queda con lo liviano (rayo del mouse, arrastre, dibujo). Acá viven las mallas,
la generación de la curva, los keyframes y la exportación.
"""
from __future__ import annotations

import base64
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, actualizar, curva, dialogos, mallas, nombres, proponer, proyecto, snapshot
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


@app.post("/api/mallas/{ident}/etiquetas")
async def subir_etiquetas(ident: str, request: Request) -> dict:
    """Recibe la segmentación de teethseg (cuerpo crudo: .json o .npy) y propone los puntos."""
    try:
        malla = mallas.obtener(ident)
        lab = proponer.leer_etiquetas(await request.body())
        propuesta = proponer.proponer(malla, lab)
    except KeyError as e:
        raise _error(e) from None
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    malla.etiquetas = lab
    return {"piezas": int(len(set(lab.tolist()) - {0})), "propuesta": propuesta}


@app.get("/api/mallas/{ident}/etiquetas/bin")
def etiquetas_binarias(ident: str) -> Response:
    """La pieza de cada cara (uint16), en el orden de las caras de /bin."""
    try:
        lab = mallas.obtener(ident).etiquetas
    except KeyError as e:
        raise _error(e) from None
    if lab is None:
        raise HTTPException(status_code=404, detail="esa malla no tiene segmentación")
    return Response(lab.astype("<u2").tobytes(), media_type="application/octet-stream")


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


@app.post("/api/mallas/carpeta")
def mallas_de_carpeta(cuerpo: dict) -> dict:
    """Carga los modelos de una carpeta (todos, o los de `nombres`). Así se sabe dónde están."""
    carpeta = Path(str(cuerpo.get("carpeta") or "")).expanduser()
    if not carpeta.is_dir():
        raise HTTPException(status_code=422, detail=f"no existe la carpeta {carpeta}")
    nombres_ = set(cuerpo.get("nombres") or [])
    cargadas, errores = [], []
    for ruta in sorted(carpeta.iterdir()):
        if ruta.suffix.lower() not in mallas.EXTENSIONES or (nombres_ and ruta.name not in nombres_):
            continue
        try:
            m = mallas.desde_archivo(ruta)
        except Exception as e:  # noqa: BLE001  (un archivo roto no frena a los demás)
            errores.append(f"{ruta.name}: {e}")
            continue
        cargadas.append({**m.resumen(), "nombre": ruta.name, "archivo": nombres.interpretar(ruta.name)})
    return {"carpeta": str(carpeta), "mallas": cargadas, "errores": errores}


@app.post("/api/referencia")
async def curva_de_referencia(request: Request, nombre: str) -> dict:
    """Lee un .pts (cuerpo crudo) para mostrarlo encima del modelo: {curvas: [{maxilar, mov, puntos}]}.

    Entiende el .pts con bloques ("sup 06" y sus puntos) y el de una sola curva, que toma el
    maxilar y el movimiento del nombre del archivo (si no los dice, quedan en null).
    """
    texto = (await request.body()).decode("utf-8", errors="replace")
    curvas, actual = [], None
    datos = nombres.interpretar(nombre)
    for linea in texto.splitlines():
        partes = linea.replace(",", " ").split()
        if not partes:
            continue
        try:
            punto = [float(x) for x in partes[:3]]
        except ValueError:
            punto = None
        if punto is None or len(partes) < 3:
            cab = re.match(r"^(sup|inf)\D*(\d+)", linea.strip(), re.IGNORECASE)
            actual = {"maxilar": cab[1].lower(), "mov": cab[2].zfill(2), "puntos": []} if cab else None
            if actual:
                curvas.append(actual)
            continue
        if actual is None:
            actual = {"maxilar": datos["maxilar"], "mov": datos["movimiento"], "puntos": []}
            curvas.append(actual)
        actual["puntos"].extend(punto)
    curvas = [c for c in curvas if len(c["puntos"]) >= 6]
    if not curvas:
        raise HTTPException(status_code=422, detail=f"{nombre}: no tiene puntos x y z")
    return {"curvas": curvas}


@app.post("/api/trabajo/guardar")
def guardar_trabajo(cuerpo: dict) -> Response:
    """El trabajo como un archivo .trimline: sin las mallas, con la ruta de cada modelo."""
    datos, sin_ruta = snapshot.guardar(cuerpo)
    return Response(datos, media_type="application/json", headers={"X-Sin-Ruta": str(len(sin_ruta))})


@app.post("/api/trabajo/abrir")
async def abrir_trabajo(request: Request) -> dict:
    """Recibe un .trimline (cuerpo crudo), carga los modelos que encuentra y devuelve el trabajo."""
    try:
        trabajo, faltan = snapshot.abrir(await request.body())
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=422, detail=f"no se pudo abrir: {str(e).strip(chr(39))}") from None
    return _abierto(trabajo, faltan)


def _abierto(trabajo: dict, faltan: list[dict]) -> dict:
    return {"trabajo": trabajo, "faltan": faltan,
            "mallas": [mallas.obtener(a["malla"]).resumen() for a in trabajo.get("archivos", [])]}


FILTRO_TRABAJO = ("Trabajo de línea de recorte (*.trimline)", "*.trimline")


def _dialogo(fn, *args):
    """Un diálogo nativo; sin diálogo en el sistema, 501 (la interfaz usa los del navegador)."""
    try:
        return fn(*args)
    except (dialogos.SinDialogo, OSError) as e:
        raise HTTPException(status_code=501, detail=str(e)) from None


@app.post("/api/trabajo/guardar-en")
def guardar_trabajo_en(cuerpo: dict) -> dict:
    """Escribe el .trimline en el disco. Sin `ruta`, la pide con el diálogo del sistema.

    Guardarlo desde acá deja saber su carpeta: ahí se buscan los modelos que se arrastraron.
    """
    ruta = cuerpo.get("ruta") or _dialogo(dialogos.guardar_archivo, cuerpo.get("inicial"),
                                          cuerpo.get("nombre") or "trabajo.trimline", "Guardar el trabajo", FILTRO_TRABAJO)
    if not ruta:
        return {"ruta": None}
    ruta = Path(ruta).expanduser()
    datos, sin_ruta = snapshot.guardar(cuerpo.get("trabajo") or {}, ruta.parent)
    try:
        ruta.write_bytes(datos)
    except OSError as e:
        raise HTTPException(status_code=422, detail=f"no se pudo guardar en {ruta}: {e.strerror or e}") from None
    return {"ruta": str(ruta), "sin_ruta": sin_ruta}


@app.post("/api/trabajo/abrir-de")
def abrir_trabajo_de(cuerpo: dict) -> dict:
    """Abre un .trimline del disco (con el diálogo del sistema si no viene `ruta`).

    Los modelos que no están en su ruta se buscan en la carpeta del .trimline.
    """
    ruta = cuerpo.get("ruta") or _dialogo(dialogos.abrir_archivo, cuerpo.get("inicial"), "Abrir un trabajo", FILTRO_TRABAJO)
    if not ruta:
        return {"ruta": None}
    ruta = Path(ruta).expanduser()
    try:
        trabajo, faltan = snapshot.abrir(ruta.read_bytes(), ruta.parent)
    except (KeyError, ValueError, OSError) as e:
        raise HTTPException(status_code=422, detail=f"no se pudo abrir {ruta.name}: {str(e).strip(chr(39))}") from None
    return {"ruta": str(ruta), **_abierto(trabajo, faltan)}


@app.get("/api/exportadores")
def exportadores() -> dict:
    return {"exportadores": [{k: v for k, v in e.items() if k != "fn"} for e in EXPORTADORES.values()]}


@app.post("/api/exportar")
def exportar_trabajo(cuerpo: dict) -> dict:
    """Resuelve todas las curvas de todos los maxilares y las pasa al exportador pedido."""
    n = cuerpo.get("n")
    paso = cuerpo.get("paso")
    if not n and not paso:
        n = 300
    trabajo = {"id": str(cuerpo.get("id") or "caso").strip() or "caso", "maxilares": {}}
    try:
        for clave in ORDEN_MAXILARES:
            maxilar = (cuerpo.get("maxilares") or {}).get(clave)
            if not maxilar or not maxilar.get("movimientos") or not maxilar.get("controladores"):
                continue
            con_clave = set(proyecto.con_keyframe(maxilar))
            if "datos" not in trabajo:
                trabajo["datos"] = nombres.interpretar(mallas.obtener(maxilar["movimientos"][0]["malla"]).nombre)
            movs = []
            for m in maxilar["movimientos"]:
                r = proyecto.resolver(maxilar, m["num"], n=int(n) if n else None, paso=float(paso) if paso else None)
                if not r["cerrada"]:
                    raise ValueError(f"{clave} {m['num']}: la curva no está cerrada (faltan vestibulares, linguales o los dos extremos)")
                orden = {c["id"]: c for c in r["controladores"]}
                t = r["tramos"][0]
                frente = mallas.obtener(m["malla"]).mas_cercano(curva.desde_el_frente(t["puntos"], t["claves"], t["info"]))
                movs.append({
                    "num": m["num"], "cerrada": True, "curva": frente, "modelo": mallas.obtener(m["malla"]).nombre,
                    "controladores": [orden[i["id"]] for i in r["tramos"][0]["info"] if i["clase"] == "cresta"],
                    "tiene_clave": m["num"] in con_clave,
                })
            trabajo["maxilares"][clave] = movs
        if not trabajo["maxilares"]:
            raise ValueError("no hay ninguna curva para exportar")
        archivos = exportar(cuerpo.get("formato") or "pts", trabajo, cuerpo.get("opciones"))
    except (KeyError, ValueError, StopIteration) as e:
        raise _error(e) from None
    if cuerpo.get("carpeta"):
        return _escribir(Path(str(cuerpo["carpeta"])).expanduser(), archivos, bool(cuerpo.get("pisar")))
    # un archivo con otra codificación que UTF-8 viaja ya en bytes (base64), tal cual va al disco
    for f in archivos:
        if f.get("codificacion"):
            f["datos"] = base64.b64encode(f.pop("texto").encode(f.pop("codificacion"), errors="replace")).decode()
    return {"archivos": archivos}


def _escribir(carpeta: Path, archivos: list[dict], pisar: bool) -> dict:
    """Deja los archivos exportados en la carpeta. Sin `pisar`, si ya hay alguno no escribe nada (409)."""
    if not carpeta.is_dir():
        raise HTTPException(status_code=422, detail=f"no existe la carpeta {carpeta}")
    ya = [f["nombre"] for f in archivos if (carpeta / f["nombre"]).exists()]
    if ya and not pisar:
        raise HTTPException(status_code=409, detail=f"ya existen en esa carpeta: {', '.join(ya)}")
    try:
        for f in archivos:
            # bytes tal cual: el texto ya trae sus saltos CRLF
            (carpeta / f["nombre"]).write_bytes(f["texto"].encode(f.get("codificacion") or "utf-8", errors="replace"))
    except OSError as e:
        raise HTTPException(status_code=422, detail=f"no se pudo escribir en {carpeta}: {e.strerror or e}") from None
    return {"carpeta": str(carpeta), "archivos": [{"nombre": f["nombre"]} for f in archivos]}


@app.post("/api/carpeta/elegir")
def elegir_carpeta(cuerpo: dict) -> dict:
    """Abre el diálogo de carpetas del sistema (en la máquina del servidor, que es esta)."""
    try:
        return {"carpeta": dialogos.elegir_carpeta(cuerpo.get("inicial"), cuerpo.get("titulo") or "Elegí la carpeta")}
    except (dialogos.SinDialogo, OSError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


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
