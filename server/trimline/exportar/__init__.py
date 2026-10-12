"""Exportadores: cada formato es un módulo que se registra acá.

Todos reciben lo mismo, ya resuelto y sin depender de cómo se dibujó:

    trabajo = {
      "id": "0044",
      "maxilares": {
        "inf": [                                   # un item por movimiento elegido, en orden
          {"num": "00", "cerrada": True,
           "curva": ndarray (N, 3),                # la línea de recorte
           "controladores": [{"id", "tipo", "pos", "clave"}],   # en el orden de la curva
           "tiene_clave": True},                   # algún controlador tiene keyframe acá
        ],
        "sup": [...],
      },
    }

(más "datos": lo que dice el nombre de los STL, ver nombres.interpretar) y devuelven una lista
de archivos [{"nombre": str, "texto": str, "codificacion"?: str}] (sin codificación: UTF-8).
Para sumar un formato:
un módulo nuevo con una función decorada con @exportador, e importarlo al final de este archivo.
"""
from __future__ import annotations

from typing import Callable

EXPORTADORES: dict[str, dict] = {}


def exportador(clave: str, titulo: str, opciones: dict | None = None) -> Callable:
    def registrar(fn: Callable) -> Callable:
        EXPORTADORES[clave] = {"clave": clave, "titulo": titulo, "opciones": opciones or {}, "fn": fn}
        return fn
    return registrar


def exportar(clave: str, trabajo: dict, opciones: dict | None = None) -> list[dict]:
    if clave not in EXPORTADORES:
        raise KeyError(f"formato desconocido: {clave} (hay: {', '.join(EXPORTADORES)})")
    e = EXPORTADORES[clave]
    return e["fn"](trabajo, {**e["opciones"], **(opciones or {})})


ORDEN_MAXILARES = ("inf", "sup")

from . import pts  # noqa: E402,F401  (se registra al importarse)
