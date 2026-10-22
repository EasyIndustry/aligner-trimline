"""El servidor local: sirve la interfaz y hace el cálculo pesado sobre las mallas.

El navegador se queda con lo liviano (rayo del mouse, arrastre, dibujo). Acá viven las mallas,
la generación de la curva, los keyframes y la exportación.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
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


def _huella_del_codigo() -> str:
    """Una huella del código del servidor (sus .py). La interfaz se sirve fresca del disco, pero
    el servidor sigue con el código con el que arrancó: si cambió, hay que reiniciarlo."""
    h = hashlib.sha1()
    for f in sorted(Path(__file__).parent.rglob("*.py")):
        try:
            h.update(f.read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:12]


_HUELLA = _huella_del_codigo()


@app.get("/api/version")
def version() -> dict:
    # `reiniciar`: el código en el disco ya no es el que está corriendo
    return {"nombre": "aligner-trimline", "version": __version__, "reiniciar": _huella_del_codigo() != _HUELLA}


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


@app.post("/api/mallas/{ident}/proponer")
def proponer_puntos(ident: str) -> dict:
    """Los puntos de control que propone la forma del modelo, y la línea del margen encontrada."""
    try:
        return proponer.proponer(mallas.obtener(ident))
    except KeyError as e:
        raise _error(e) from None
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@app.get("/api/mallas/{ident}/etiquetas")
def etiquetas(ident: str) -> Response:
    """El diente de cada cara (int16: 0.. dientes, -1 encía, -2 attachment, -3 base), en el orden de /bin."""
    try:
        lab = mallas.obtener(ident).etiquetas
    except KeyError as e:
        raise _error(e) from None
    if lab is None:
        raise HTTPException(status_code=404, detail="esa malla no está segmentada")
    return Response(lab.astype("<i2").tobytes(), media_type="application/octet-stream")


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
    """Carga los modelos de una carpeta (todos, o los de `nombres`). Así se sabe dónde están.

    Con `listar`, solo dice qué modelos hay (sin leerlos): la interfaz los pide de a uno para
    mostrar cuál está leyendo.
    """
    carpeta = Path(str(cuerpo.get("carpeta") or "")).expanduser()
    if not carpeta.is_dir():
        raise HTTPException(status_code=422, detail=f"no existe la carpeta {carpeta}")
    if cuerpo.get("listar"):
        return {"carpeta": str(carpeta), "nombres": [r.name for r in sorted(carpeta.iterdir())
                                                     if r.is_file() and r.suffix.lower() in mallas.EXTENSIONES]}
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


@app.post("/api/mallas/olvidar")
def olvidar_mallas(cuerpo: dict) -> dict:
    """Proyecto nuevo: libera las mallas del anterior (menos las de `conservar`)."""
    return {"olvidadas": mallas.olvidar(cuerpo.get("conservar") or [])}


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
# al abrir también el respaldo que se escribe solo (<ID>.trimline.bak, en la carpeta de los modelos)
FILTRO_ABRIR = ("Trabajo de línea de recorte (*.trimline, *.trimline.bak)", "*.trimline;*.trimline.bak")


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
    Con `no_pisar` (el guardado automático de un proyecto nuevo), 409 si ya hay un archivo ahí.
    Con `respaldo` y sin `ruta` (ningún modelo dice su carpeta: se arrastraron), el respaldo va
    a la carpeta de datos del programa, en respaldos/<nombre>.
    """
    if cuerpo.get("respaldo") and not cuerpo.get("ruta"):
        carpeta = (_datos() or Path.home() / ".local" / "share" / "aligner-trimline") / "respaldos"
        carpeta.mkdir(parents=True, exist_ok=True)
        cuerpo = {**cuerpo, "ruta": str(carpeta / Path(cuerpo.get("nombre") or "trabajo.trimline.bak").name)}
    ruta = cuerpo.get("ruta") or _dialogo(dialogos.guardar_archivo, cuerpo.get("inicial"),
                                          cuerpo.get("nombre") or "trabajo.trimline", "Guardar el trabajo", FILTRO_TRABAJO)
    if not ruta:
        return {"ruta": None}
    ruta = Path(ruta).expanduser()
    if cuerpo.get("no_pisar") and ruta.exists():
        raise HTTPException(status_code=409, detail=f"ya hay un {ruta.name} en {ruta.parent}")
    datos, sin_ruta = snapshot.guardar(cuerpo.get("trabajo") or {}, ruta.parent)
    try:
        ruta.write_bytes(datos)
    except OSError as e:
        raise HTTPException(status_code=422, detail=f"no se pudo guardar en {ruta}: {e.strerror or e}") from None
    # la ruta de cada modelo, también la de los arrastrados que se encontraron junto al archivo
    rutas = {}
    for a in (cuerpo.get("trabajo") or {}).get("archivos", []):
        try:
            if mallas.obtener(a["malla"]).ruta:
                rutas[a["malla"]] = mallas.obtener(a["malla"]).ruta
        except KeyError:
            pass
    return {"ruta": str(ruta), "sin_ruta": sin_ruta, "rutas": rutas}


@app.post("/api/trabajo/abrir-de")
def abrir_trabajo_de(cuerpo: dict) -> dict:
    """Abre un .trimline del disco (con el diálogo del sistema si no viene `ruta`).

    Los modelos que no están en su ruta se buscan en la carpeta del .trimline.
    """
    ruta = cuerpo.get("ruta") or _dialogo(dialogos.abrir_archivo, cuerpo.get("inicial"), "Abrir un trabajo", FILTRO_ABRIR)
    if not ruta:
        return {"ruta": None}
    ruta = Path(ruta).expanduser()
    try:
        datos = ruta.read_bytes()
        if cuerpo.get("listar"):
            # qué modelos tiene, sin leerlos (un .trimline viejo, con las mallas adentro: ninguno)
            nombres_ = [] if datos[:2] == b"PK" else [a.get("nombre", "") for a in json.loads(datos.decode("utf-8-sig")).get("archivos", [])]
            return {"ruta": str(ruta), "nombres": nombres_}
        if cuerpo.get("solo") is not None:
            _, faltan = snapshot.abrir(datos, ruta.parent, solo=int(cuerpo["solo"]))
            return {"ruta": str(ruta), "encontrado": not faltan}
        trabajo, faltan = snapshot.abrir(datos, ruta.parent)
    except (KeyError, ValueError, OSError, AttributeError) as e:
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
            def resuelta(mx: dict, m: dict) -> dict:
                r = proyecto.resolver(mx, m["num"], n=int(n) if n else None, paso=float(paso) if paso else None)
                if not r["cerrada"]:
                    raise ValueError(f"{clave} {m['num']}: la curva no está cerrada (faltan vestibulares, linguales o los dos extremos)")
                orden = {c["id"]: c for c in r["controladores"]}
                t = r["tramos"][0]
                frente = mallas.obtener(m["malla"]).mas_cercano(curva.desde_el_frente(t["puntos"], t["claves"], t["info"]))
                return {
                    "num": m["num"], "cerrada": True, "curva": frente, "modelo": mallas.obtener(m["malla"]).nombre,
                    "controladores": [orden[i["id"]] for i in t["info"] if i["clase"] == "cresta"],
                    "tiene_clave": m["num"] in con_clave,
                }
            trabajo["maxilares"][clave] = [resuelta(maxilar, m) for m in maxilar["movimientos"]]
            # las curvas adicionales: cada una sobre la malla de su origen, y van aparte
            for num, ad in sorted((maxilar.get("adicionales") or {}).items()):
                if not ad.get("controladores"):
                    continue
                mx = proyecto.adicional(maxilar, num)
                trabajo.setdefault("adicionales", []).append({**resuelta(mx, mx["movimientos"][0]), "maxilar": clave, "origen": ad.get("origen")})
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


def _datos() -> Path | None:
    return Path(os.environ["TRIMLINE_HOME"]) if os.environ.get("TRIMLINE_HOME") else None


@app.get("/api/actualizacion")
def actualizacion(buscar: bool = False) -> dict:
    """Qué versión está puesta, cómo salió el último cambio y, con buscar=true, qué releases hay."""
    return {**actualizar.estado(buscar), "version": __version__, "ultimo": actualizar.ultimo_cambio(_datos())}


@app.post("/api/actualizacion/instalar")
def actualizacion_instalar(cuerpo: dict) -> dict:
    try:
        res = actualizar.instalar(str(cuerpo.get("tag") or ""))
    except Exception as e:  # noqa: BLE001  (red, disco o release mal armado: se le cuenta al usuario)
        raise HTTPException(status_code=422, detail=str(e)) from None
    reiniciar(res["modo"], res["tag"])
    return res


@app.post("/api/actualizacion/revertir")
def actualizacion_revertir() -> dict:
    try:
        res = actualizar.revertir()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(e)) from None
    reiniciar(res["modo"], res["tag"])
    return res


def reiniciar(modo: str, tag: str | None) -> None:
    """Lanza el cambio de versión (otro proceso: espera a que este suelte app/, la cambia y abre
    el programa de nuevo) y apaga este proceso un momento después."""
    actualizar.lanzar_cambio(modo, tag, _datos())
    threading.Timer(0.5, apagar).start()
    # si algo traba el cierre ordenado (una conexión que no suelta, un hilo), este proceso igual
    # se termina: si quedara vivo, seguiría atendiendo la versión vieja
    salida = threading.Timer(10, os._exit, [0])
    salida.daemon = True
    salida.start()


@app.get("/")
def raiz() -> RedirectResponse:
    return RedirectResponse("/index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
