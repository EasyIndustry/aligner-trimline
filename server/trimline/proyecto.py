"""El estado de un trabajo y cómo se resuelve en cada movimiento.

Un maxilar es:

    {
      "movimientos": [{"num": "00", "malla": "<id>"}, ...],   # los elegidos, en orden
      "offset": 0.0, "amplitud": 0.0, "ancho": 0.4,           # valen para todo el tratamiento
      "controladores": [
        {"id": "c1", "tipo": "v", "claves": {"00": [x, y, z], "08": [x, y, z]},
         "manijas": {"a": [dx, dy, dz], "b": [dx, dy, dz]}},   # opcional: su festón puesto a mano
      ],
    }

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
    malla = mallas.obtener(next(m["malla"] for m in movs if m["num"] == num))
    ctrl = []
    for c in maxilar.get("controladores", []):
        p = posicion(c, nums, num)
        if p is None:
            continue
        ctrl.append({"id": c["id"], "tipo": c["tipo"], "pos": p, "clave": num in c.get("claves", {}),
                     "manijas": c.get("manijas")})
    if ctrl:
        sobre = malla.mas_cercano(np.array([c["pos"] for c in ctrl]))
        for c, p in zip(ctrl, sobre):
            c["pos"] = p
    res = curva.generar(malla, ctrl, float(maxilar.get("offset", 0.0)), float(maxilar.get("amplitud", 0.0)), n=n, paso=paso,
                        ancho=float(maxilar.get("ancho", curva.ANCHO)))
    res["controladores"] = ctrl
    res["num"] = num
    return res


def con_keyframe(maxilar: dict) -> list[str]:
    """Los movimientos (elegidos) donde algún controlador tiene keyframe."""
    nums = [m["num"] for m in maxilar["movimientos"]]
    usados = {k for c in maxilar.get("controladores", []) for k in c.get("claves", {})}
    return [n for n in nums if n in usados]
