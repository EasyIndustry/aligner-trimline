"""El estado de un trabajo y cómo se resuelve en cada movimiento.

Un maxilar es:

    {
      "movimientos": [{"num": "00", "malla": "<id>"}, ...],   # los elegidos, en orden
      "offset": 0.0, "amplitud": 0.0, "ancho": 0.4,           # valen para todo el tratamiento
      "lingual": {"offset": 0.0, "amplitud": 0.0, "ancho": 0.4},  # opcional: el lado lingual distinto
                                                              # (entonces los de arriba son los vestibulares)
      "controladores": [
        {"id": "c1", "tipo": "v", "claves": {"00": [x, y, z], "08": [x, y, z]},
         "manijas": {"a": [dx, dy, dz], "b": [dx, dy, dz]},    # opcional: su festón puesto a mano
         "offset": true, "festoneado": true},                  # opcional: si lo mueven los deslizadores
      ],
      "inversas": {"c1|c2": [dx, dy, dz]},                     # opcional: crestas inversas corridas a mano
      "sinAjuste": {"05": {"offset": false, "festoneado": false}},  # opcional: movimientos que no
                                                              # llevan offset o festoneado (corte seco)
      "adicionales": {"X18": {"origen": "18", "offset": ..., "amplitud": ..., "ancho": ...,
                              "controladores": [...], "inversas": {...}}},  # opcional, ver abajo
    }

Una curva ADICIONAL es una curva de más, sobre la malla de un movimiento (`origen`), que se
ajusta por su cuenta: tiene sus propios controladores (con keyframe en su número, `X18`) y sus
propios deslizadores. Arranca como copia de ese movimiento y se exporta en un archivo aparte.

`claves` son los KEYFRAMES del controlador: posiciones absolutas en los movimientos donde el
usuario lo puso o lo movió. Entre dos keyframes la posición avanza de a poco, movimiento a
movimiento; antes del primero y después del último se queda quieta. Corregir un keyframe no
toca a los demás: solo cambia la transición.
"""
from __future__ import annotations

import numpy as np

from . import curva, mallas


def posicion(controlador: dict, nums: list[str], num: str) -> np.ndarray | None:
    """Dónde está un controlador en el movimiento `num`, interpolando sus keyframes."""
    i = nums.index(num)
    claves = sorted((nums.index(k), np.asarray(p, dtype=np.float64))
                    for k, p in controlador.get("claves", {}).items() if k in nums)
    if not claves:
        return None
    if i <= claves[0][0]:
        return claves[0][1]
    if i >= claves[-1][0]:
        return claves[-1][1]
    for (ia, pa), (ib, pb) in zip(claves, claves[1:]):
        if ia <= i <= ib:
            return pa + (pb - pa) * ((i - ia) / (ib - ia))
    return claves[-1][1]


def resolver(maxilar: dict, num: str, n: int | None = 500, paso: float | None = None) -> dict:
    """Controladores y curva de un movimiento, apoyados sobre la malla de ESE movimiento."""
    movs = maxilar["movimientos"]
    nums = [m["num"] for m in movs]
    mov = next(m for m in movs if m["num"] == num)
    malla = mallas.obtener(mov["malla"], mov.get("ruta"))
    # en este movimiento, ¿va sin offset o sin festoneado? Es como si ningún controlador los
    # siguiera: los puntos y los deslizadores no cambian, y los demás movimientos tampoco
    sin = (maxilar.get("sinAjuste") or {}).get(num) or {}
    ctrl = []
    for c in maxilar.get("controladores", []):
        p = posicion(c, nums, num)
        if p is None:
            continue
        ctrl.append({"id": c["id"], "tipo": c["tipo"], "pos": p, "clave": num in c.get("claves", {}),
                     "manijas": c.get("manijas"),
                     "offset": c.get("offset", True) and sin.get("offset", True) is not False,
                     "festoneado": c.get("festoneado", True) and sin.get("festoneado", True) is not False})
    if ctrl:
        sobre = malla.mas_cercano(np.array([c["pos"] for c in ctrl]))
        for c, p in zip(ctrl, sobre):
            c["pos"] = p
    res = curva.generar(malla, ctrl, float(maxilar.get("offset", 0.0)), float(maxilar.get("amplitud", 0.0)), n=n, paso=paso,
                        ancho=float(maxilar.get("ancho", curva.ANCHO)), inversas=maxilar.get("inversas"),
                        lingual=maxilar.get("lingual"))
    res["controladores"] = ctrl
    res["num"] = num
    return res


def adicional(maxilar: dict, num: str) -> dict:
    """La curva adicional `num` como un maxilar de un solo movimiento (sobre la malla de su origen)."""
    ad = (maxilar.get("adicionales") or {})[num]
    mov = next((m for m in maxilar["movimientos"] if m["num"] == ad.get("origen")), None)
    if mov is None:
        raise ValueError(f"{num}: el movimiento {ad.get('origen')}, del que es copia, no está elegido")
    return {**ad, "movimientos": [{"num": num, "malla": mov["malla"], "ruta": mov.get("ruta")}]}


def con_keyframe(maxilar: dict) -> list[str]:
    """Los movimientos (elegidos) donde algún controlador tiene keyframe."""
    nums = [m["num"] for m in maxilar["movimientos"]]
    usados = {k for c in maxilar.get("controladores", []) for k in c.get("claves", {})}
    return [n for n in nums if n in usados]
