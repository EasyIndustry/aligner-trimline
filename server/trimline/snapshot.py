"""El archivo `.trimline`: una foto entera del trabajo, para seguirlo después tal como quedó.

Es un zip con:

    trabajo.json          lo que manda la interfaz (archivos, maxilares, vista, exportación...)
    mallas.json           {id: {nombre, arriba, base}} de cada malla que usa el trabajo
    mallas/<id>.bin       la malla ya soldada, en el mismo formato que viaja al navegador

Con las mallas adentro, abrirlo no pide volver a arrastrar los STL.
"""
from __future__ import annotations

import io
import json
import zipfile

from . import mallas

FORMATO = "aligner-trimline"
VERSION = 2


def guardar(trabajo: dict) -> bytes:
    trabajo = {**trabajo, "formato": FORMATO, "version": VERSION}
    ids = sorted({a["malla"] for a in trabajo.get("archivos", []) if a.get("malla")})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr("trabajo.json", json.dumps(trabajo, ensure_ascii=False, indent=1))
        info = {}
        for ident in ids:
            m = mallas.obtener(ident)
            info[ident] = {"nombre": m.nombre, "arriba": [float(x) for x in m.arriba], "base": m.base}
            z.writestr(f"mallas/{ident}.bin", m.binario())
        z.writestr("mallas.json", json.dumps(info, indent=1))
    return buf.getvalue()


def abrir(datos: bytes) -> dict:
    """Carga las mallas del archivo y devuelve el trabajo."""
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
