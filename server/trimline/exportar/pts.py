"""Formato .pts, el que lee el software que arma el programa del KUKA.

Copia el de los casos que ya se cortan (`BN595.pts`, `BN595 PC.pts` y los datos del caso):

- Bloques de texto: una línea `<maxilar> <movimiento>` (`inf 00`) y debajo un punto por línea,
  `x y z` separados por espacios. Inferior primero, saltos de línea CRLF.
- Números con hasta 6 decimales y sin ceros de más: `12.74834`, `-1`.
- Cada curva arranca adelante, en x = 0 del lado vestibular, y sigue hacia +x (eso lo hace el
  servidor antes de llegar acá).
- `<ID> PC.pts`: los puntos de control del primer y del último movimiento y de los que tienen
  keyframe. En cada bloque: el extremo de -x, los vestibulares, el extremo de +x y los
  linguales, los dos lados de -x a +x.
- `<ID>.curva`: JSON {"referencia", "id", "nombre", "etapa"} en Latin-1, sacado del nombre de los STL
  (`BN595 Apellido Nombre 2.0 BIS Sup 00 CNC3.stl` → CNC3, BN595, "Apellido Nombre 2.0", BIS).

pts-por-curva es lo mismo con una curva por archivo, con el nombre del modelo de ese movimiento
(`BZ254-L22-A-solido.stl` → `BZ254-L22-A-solido.pts`); sin modelo, `<ID>_<maxilar>_<mov>.pts`.

Las curvas adicionales (`X18`: una copia del 18 ajustada aparte) van SOLO en su propio archivo,
`<ID> <maxilar> X18.pts`: con su encabezado en el formato pts, sin él en pts-por-curva.
"""
from __future__ import annotations

import re

import json

import numpy as np

from . import ORDEN_MAXILARES, exportador

OPCIONES = {
    "decimales": 6,
    "salto": "\r\n",        # como los archivos que ya consume el generador del KUKA
    "sufijo_pc": " PC",
}


def _bloque(encabezado: str | None, puntos, decimales: int, salto: str) -> str:
    lineas = [encabezado] if encabezado else []
    for p in np.asarray(puntos, dtype=np.float64).reshape(-1, 3):
        lineas.append(" ".join(_num(x, decimales) for x in p))
    return salto.join(lineas) + salto


def _num(x: float, decimales: int) -> str:
    t = f"{x:.{decimales}f}".rstrip("0").rstrip(".")
    return "0" if t in ("-0", "") else t                      # nunca "-0"


def _maxilares(trabajo: dict):
    for maxilar in ORDEN_MAXILARES:
        if trabajo["maxilares"].get(maxilar):
            yield maxilar, trabajo["maxilares"][maxilar]


def _orden_maquina(controladores: list[dict]) -> list[dict]:
    """Extremo de -x, vestibulares, extremo de +x, linguales; cada lado de -x a +x."""
    x = lambda c: float(c["pos"][0])
    def lado(tipo):
        t = [c for c in controladores if c["tipo"] == tipo]          # vienen en el orden de la arcada
        return t[::-1] if len(t) > 1 and x(t[0]) > x(t[-1]) else t
    ext = sorted((c for c in controladores if c["tipo"] == "e"), key=x)
    return ext[:1] + lado("v") + ext[1:2] + lado("l") + ext[2:]


def _control(trabajo: dict, o: dict) -> dict:
    bloques = []
    for maxilar, movs in _maxilares(trabajo):
        for i, m in enumerate(movs):
            if (m["tiene_clave"] or i in (0, len(movs) - 1)) and m["controladores"]:
                bloques.append(_bloque(f"{maxilar} {m['num']}", [c["pos"] for c in _orden_maquina(m["controladores"])],
                                       o["decimales"], o["salto"]))
    return {"nombre": f"{trabajo['id']}{o['sufijo_pc']}.pts", "texto": "".join(bloques)}


def _adicionales(trabajo: dict, o: dict, encabezado: bool) -> list[dict]:
    return [{"nombre": f"{trabajo['id']} {a['maxilar']} {a['num']}.pts",
             "texto": _bloque(f"{a['maxilar']} {a['num']}" if encabezado else None, a["curva"], o["decimales"], o["salto"])}
            for a in trabajo.get("adicionales", []) if len(a["curva"])]


def _datos(trabajo: dict) -> dict:
    d = trabajo.get("datos") or {}
    nombre = " ".join(x for x in (d.get("paciente"), d.get("etapa")) if x)
    texto = json.dumps({"referencia": d.get("sufijo") or "", "id": trabajo["id"], "nombre": nombre,
                        "etapa": d.get("fase") or ""}, ensure_ascii=False)
    return {"nombre": f"{trabajo['id']}.curva", "texto": texto, "codificacion": "latin-1"}


@exportador("pts", "PTS (un archivo con todas las curvas)", OPCIONES)
def un_archivo(trabajo: dict, o: dict) -> list[dict]:
    texto = "".join(
        _bloque(f"{maxilar} {m['num']}", m["curva"], o["decimales"], o["salto"])
        for maxilar, movs in _maxilares(trabajo) for m in movs if len(m["curva"])
    )
    return [{"nombre": f"{trabajo['id']}.pts", "texto": texto}, _control(trabajo, o), _datos(trabajo), *_adicionales(trabajo, o, True)]


@exportador("pts-por-curva", "PTS (un archivo por maxilar y movimiento)", OPCIONES)
def por_curva(trabajo: dict, o: dict) -> list[dict]:
    archivos = [
        {"nombre": (re.sub(r"\.[A-Za-z0-9]+$", "", m["modelo"]) if m.get("modelo") else f"{trabajo['id']}_{maxilar}_{m['num']}") + ".pts",
         "texto": _bloque(None, m["curva"], o["decimales"], o["salto"])}
        for maxilar, movs in _maxilares(trabajo) for m in movs if len(m["curva"])
    ]
    return archivos + [_control(trabajo, o), _datos(trabajo)] + _adicionales(trabajo, o, False)
