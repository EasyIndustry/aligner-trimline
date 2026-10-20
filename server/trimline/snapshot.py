"""El archivo `.trimline`: una foto del trabajo, para seguirlo después tal como quedó.

Es un JSON con lo que manda la interfaz (archivos, maxilares, vista, exportación...). Las mallas
no van adentro: se guardan muchas veces y pesarían mucho. De cada modelo va su `ruta` y al abrir
se vuelve a leer de ahí. Lo arrastrado al navegador no trae la ruta: al guardar se busca en la
carpeta del .trimline un archivo con ese nombre y el mismo contenido. Al abrir, lo que no está en
su ruta se busca por nombre en la carpeta del .trimline.

Los `.trimline` de la versión 2 eran un zip con las mallas adentro; se siguen abriendo.
"""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

from . import mallas

FORMATO = "aligner-trimline"
VERSION = 3


def guardar(trabajo: dict, carpeta: str | Path | None = None) -> tuple[bytes, list[str]]:
    """El contenido del archivo y los nombres de los modelos de los que no se sabe la ruta.

    `carpeta` es donde se va a guardar, si se sabe: ahí se buscan los modelos sin ruta.
    """
    archivos = []
    for a in trabajo.get("archivos", []):
        try:
            malla = mallas.obtener(a["malla"])
        except KeyError:
            malla = None
        ruta = (malla.ruta if malla else None) or a.get("ruta")
        if not ruta and malla and carpeta:
            ruta = _misma(Path(carpeta) / a.get("nombre", ""), malla.id)
            malla.ruta = ruta
        archivos.append({**a, "ruta": ruta} if ruta else {k: v for k, v in a.items() if k != "ruta"})
    trabajo = {**trabajo, "archivos": archivos, "formato": FORMATO, "version": VERSION}
    sin_ruta = [a.get("nombre", "") for a in archivos if not a.get("ruta")]
    return json.dumps(trabajo, ensure_ascii=False, indent=1).encode("utf-8"), sin_ruta


def _misma(ruta: Path, ident: str) -> str | None:
    """La ruta, si ahí hay un archivo con el contenido de la malla `ident`."""
    try:
        if ruta.is_file() and hashlib.sha1(ruta.read_bytes()).hexdigest()[:16] == ident:
            return str(ruta.resolve())
    except OSError:
        pass
    return None


def abrir(datos: bytes, carpeta: str | Path | None = None, solo: int | None = None) -> tuple[dict, list[dict]]:
    """Devuelve el trabajo y los archivos cuyos modelos no se encontraron.

    Cada modelo se busca en su ruta y, si no está, por nombre en `carpeta` (donde está el
    .trimline, si se sabe). Los que se encuentran quedan cargados; si el STL cambió desde que se
    guardó, el archivo pasa a apuntar a la malla nueva.

    Con `solo` carga únicamente ese archivo (su índice): la interfaz los pide de a uno para
    mostrar cuál está leyendo, y al final abre todo (ya cargado, es inmediato).
    """
    if datos[:2] == b"PK":
        return _abrir_zip(datos), []
    try:
        trabajo = json.loads(datos.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("no es un archivo .trimline") from None
    if not isinstance(trabajo, dict) or trabajo.get("formato") != FORMATO:
        raise ValueError("no es un trabajo de aligner-trimline")
    encontrados, faltan = [], []
    archivos = trabajo.get("archivos", [])
    if solo is not None:
        archivos = archivos[solo:solo + 1]
    for a in archivos:
        candidatas = [Path(a["ruta"])] if a.get("ruta") else []
        if carpeta:
            candidatas += [Path(carpeta) / a.get("nombre", "")]
            if a.get("ruta"):
                candidatas += [Path(carpeta) / Path(a["ruta"].replace("\\", "/")).name]
        try:
            malla = mallas.obtener(a["malla"])               # sigue abierta desde antes
            if not malla.ruta and carpeta:
                malla.ruta = next(filter(None, (_misma(c, malla.id) for c in candidatas)), None)
            encontrados.append(a)
            continue
        except KeyError:
            pass
        for c in candidatas:
            try:
                if c.is_file():
                    a["malla"] = mallas.desde_archivo(c).id
                    break
            except (OSError, ValueError):
                continue
        else:
            faltan.append(a)
            continue
        encontrados.append(a)
    trabajo["archivos"] = encontrados
    return trabajo, faltan


def _abrir_zip(datos: bytes) -> dict:
    """Versión 2: zip con trabajo.json, mallas.json y mallas/<id>.bin."""
    try:
        z = zipfile.ZipFile(io.BytesIO(datos))
    except zipfile.BadZipFile:
        raise ValueError("no es un archivo .trimline") from None
    with z:
        trabajo = json.loads(z.read("trabajo.json"))
        if trabajo.get("formato") != FORMATO:
            raise ValueError("no es un trabajo de aligner-trimline")
        for ident, m in json.loads(z.read("mallas.json")).items():
            mallas.desde_binario(ident, m["nombre"], z.read(f"mallas/{ident}.bin"), m["arriba"], m["base"])
    return trabajo
