"""El archivo `.trimline`: una foto del trabajo, para seguirlo después tal como quedó.

Es un JSON con lo que manda la interfaz (archivos, maxilares, vista, exportación...). Las mallas
no van adentro: se guardan muchas veces y pesarían mucho. De cada modelo va su `ruta` (cuando se
sabe, o sea si se cargó eligiendo la carpeta) y al abrir se vuelve a leer de ahí.

Los `.trimline` de la versión 2 eran un zip con las mallas adentro; se siguen abriendo.
"""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from . import mallas

FORMATO = "aligner-trimline"
VERSION = 3


def guardar(trabajo: dict) -> tuple[bytes, list[str]]:
    """El contenido del archivo y los nombres de los modelos de los que no se sabe la ruta."""
    archivos = []
    for a in trabajo.get("archivos", []):
        try:
            ruta = mallas.obtener(a["malla"]).ruta or a.get("ruta")
        except KeyError:
            ruta = a.get("ruta")
        archivos.append({**a, "ruta": ruta} if ruta else {k: v for k, v in a.items() if k != "ruta"})
    trabajo = {**trabajo, "archivos": archivos, "formato": FORMATO, "version": VERSION}
    sin_ruta = [a.get("nombre", "") for a in archivos if not a.get("ruta")]
    return json.dumps(trabajo, ensure_ascii=False, indent=1).encode("utf-8"), sin_ruta


def abrir(datos: bytes) -> tuple[dict, list[dict]]:
    """Devuelve el trabajo y los archivos cuyos modelos no se encontraron.

    Los que se encuentran quedan cargados; si el STL cambió desde que se guardó, el archivo pasa a
    apuntar a la malla nueva.
    """
    if datos[:2] == b"PK":
        return _abrir_zip(datos), []
    try:
        trabajo = json.loads(datos.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("no es un archivo .trimline") from None
    if not isinstance(trabajo, dict) or trabajo.get("formato") != FORMATO:
        raise ValueError("no es un trabajo de aligner-trimline")
    faltan = []
    for a in trabajo.get("archivos", []):
        try:
            mallas.obtener(a["malla"])                    # sigue abierta desde antes
            continue
        except KeyError:
            pass
        ruta = a.get("ruta")
        try:
            if not ruta or not Path(ruta).is_file():
                raise FileNotFoundError(ruta)
            a["malla"] = mallas.desde_archivo(ruta).id
        except (OSError, ValueError):
            faltan.append(a)
    trabajo["archivos"] = [a for a in trabajo.get("archivos", []) if a not in faltan]
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
