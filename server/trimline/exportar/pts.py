"""Formato .pts, el que lee el software que arma el programa del KUKA.

Bloques de texto: una línea `<maxilar> <movimiento>` (por ejemplo `inf 00`) y debajo un punto
por línea, `x y z` separados por espacios. Solo posición, sin orientación de herramienta.

- pts            `<ID>.pts` con todas las curvas y `<ID>_PC.pts` con los puntos de control de los
                 movimientos que tienen keyframe.
- pts-por-curva  lo mismo, pero una curva por archivo: `<ID>_<maxilar>_<mov>.pts`.
"""
from __future__ import annotations

import numpy as np

from . import ORDEN_MAXILARES, exportador

OPCIONES = {
    "decimales": 4,
    "salto": "\r\n",        # como los archivos que ya consume el generador del KUKA
    "sufijo_pc": "_PC",
}


def _bloque(encabezado: str | None, puntos, decimales: int, salto: str) -> str:
    lineas = [encabezado] if encabezado else []
    for p in np.asarray(puntos, dtype=np.float64).reshape(-1, 3):
        lineas.append(" ".join(_num(x, decimales) for x in p))
    return salto.join(lineas) + salto


def _num(x: float, decimales: int) -> str:
    t = f"{x:.{decimales}f}"
    return "0." + "0" * decimales if float(t) == 0 else t      # nunca "-0.0000"


def _maxilares(trabajo: dict):
    for maxilar in ORDEN_MAXILARES:
        if trabajo["maxilares"].get(maxilar):
            yield maxilar, trabajo["maxilares"][maxilar]


def _control(trabajo: dict, o: dict) -> dict:
    texto = "".join(
        _bloque(f"{maxilar} {m['num']}", [c["pos"] for c in m["controladores"]], o["decimales"], o["salto"])
        for maxilar, movs in _maxilares(trabajo) for m in movs if m["tiene_clave"] and m["controladores"]
    )
    return {"nombre": f"{trabajo['id']}{o['sufijo_pc']}.pts", "texto": texto}


@exportador("pts", "PTS (un archivo con todas las curvas)", OPCIONES)
def un_archivo(trabajo: dict, o: dict) -> list[dict]:
    texto = "".join(
        _bloque(f"{maxilar} {m['num']}", m["curva"], o["decimales"], o["salto"])
        for maxilar, movs in _maxilares(trabajo) for m in movs if len(m["curva"])
    )
    return [{"nombre": f"{trabajo['id']}.pts", "texto": texto}, _control(trabajo, o)]


@exportador("pts-por-curva", "PTS (un archivo por maxilar y movimiento)", OPCIONES)
def por_curva(trabajo: dict, o: dict) -> list[dict]:
    archivos = [
        {"nombre": f"{trabajo['id']}_{maxilar}_{m['num']}.pts",
         "texto": _bloque(None, m["curva"], o["decimales"], o["salto"])}
        for maxilar, movs in _maxilares(trabajo) for m in movs if len(m["curva"])
    ]
    return archivos + [_control(trabajo, o)]
