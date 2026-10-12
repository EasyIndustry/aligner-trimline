"""La curva generativa: de pocos controladores con significado a una línea de recorte cerrada.

El usuario no marca la curva. Marca un punto en la encía debajo de cada diente (vestibular y
lingual) y los dos extremos de la arcada. De ahí:

- cada controlador es una CRESTA;
- el punto medio entre dos controladores vecinos es la CRESTA INVERSA (la zona entre dientes),
  que sube o baja `amplitud` sobre el eje vertical del modelo;
- todo se desplaza junto `offset` sobre ese mismo eje;
- de clave a clave va una Bézier cúbica con tangentes planas en los extremos, y `ancho` (el
  largo de esas tangentes) decide cuán anchos son los festones;
- y siempre termina apoyado sobre la malla.
"""
from __future__ import annotations

import numpy as np

from .mallas import Malla

TIPOS = ("v", "l", "e")          # vestibular, lingual, extremo


def _base_plana(arriba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ref = np.array([1.0, 0, 0]) if abs(arriba[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(arriba, ref)
    e1 /= np.linalg.norm(e1)
    return e1, np.cross(arriba, e1)


def ordenar(controladores: list[dict], arriba: np.ndarray) -> dict:
    """Ordena los controladores a lo largo de la arcada, sin depender del orden de los clics.

    Con los dos extremos marcados la curva es cerrada: E1 → vestibulares → E2 → linguales → E1.
    Sin ellos devuelve los tramos sueltos que haya, para ir mostrando el avance.
    """
    por_tipo = {t: [c for c in controladores if c["tipo"] == t] for t in TIPOS}
    v, lin, ext = por_tipo["v"], por_tipo["l"], por_tipo["e"]
    if len(ext) < 2 or not v or not lin:
        return {"cerrada": False, "tramos": [t for t in (v, lin) if len(t) >= 2]}
    e1, e2 = _base_plana(arriba)

    def plano(c):
        p = np.asarray(c["pos"], dtype=np.float64)
        return np.array([p @ e1, p @ e2])

    centro = np.mean([plano(c) for c in v + lin], axis=0)
    abertura = np.mean([plano(c) for c in ext[:2]], axis=0) - np.mean([plano(c) for c in v], axis=0)
    ref = np.arctan2(abertura[1], abertura[0])

    def t(c):
        d = plano(c) - centro
        return (np.arctan2(d[1], d[0]) - ref) % (2 * np.pi)

    ext = sorted(ext[:2], key=t)
    return {
        "cerrada": True,
        "tramos": [[ext[0]] + sorted(v, key=t) + [ext[1]] + sorted(lin, key=t, reverse=True)],
    }


def clave_inversa(a: str, b: str) -> str:
    """Cómo se nombra la cresta inversa entre dos controladores, sin importar el sentido."""
    return "|".join(sorted((a, b)))


def _claves(tramo: list[dict], arriba: np.ndarray, offset: float, amplitud: float, cerrada: bool,
            inversas: dict | None = None) -> tuple[np.ndarray, list[dict]]:
    """Los puntos por donde pasa la curva: crestas y crestas inversas, ya desplazados.

    Un controlador con `offset: False` no se desplaza con el offset global, y uno con
    `festoneado: False` no festonea: la cresta inversa entre dos así queda recta. Entre uno que
    sí y uno que no, va a mitad de camino. `inversas[clave_inversa(a, b)]` es lo que el usuario
    corrió a mano esa cresta inversa, sobre la posición calculada.
    """
    inversas = inversas or {}
    pts, info = [], []
    n = len(tramo)
    usa = lambda c, k: 1.0 if c.get(k, True) is not False else 0.0
    for i, c in enumerate(tramo):
        p = np.asarray(c["pos"], dtype=np.float64)
        pts.append(p + offset * usa(c, "offset") * arriba)
        info.append({"clase": "cresta", "id": c["id"], "tipo": c["tipo"]})
        if i + 1 == n and not cerrada:
            break
        sig = tramo[(i + 1) % n]
        if c["tipo"] == sig["tipo"] and c["tipo"] != "e":       # entre dos dientes del mismo lado
            medio = (p + np.asarray(sig["pos"], dtype=np.float64)) / 2
            desp = (offset * (usa(c, "offset") + usa(sig, "offset")) / 2
                    + amplitud * (usa(c, "festoneado") + usa(sig, "festoneado")) / 2)
            clave = clave_inversa(c["id"], sig["id"])
            pts.append(medio + desp * arriba + np.asarray(inversas.get(clave, (0, 0, 0)), dtype=np.float64))
            info.append({"clase": "inversa", "entre": [c["id"], sig["id"]], "clave": clave, "tipo": c["tipo"]})
    return np.array(pts), info


ANCHO = 0.4                  # manija de una cresta, en fracción del tramo hasta la clave vecina
ANCHO_TOTAL = 0.8            # cresta + cresta inversa: lo que gana una lo pierde la otra
ANCHO_EXTREMO = 0.33


def _manijas(claves: np.ndarray, info: list[dict], arriba: np.ndarray, ancho: float,
             propias: dict, cerrada: bool) -> np.ndarray:
    """Las dos manijas Bézier de cada clave: (K, 2, 3), la de entrada y la de salida.

    En cada cresta y cresta inversa la tangente es PLANA (sin componente vertical): ahí la curva
    tiene su máximo o su mínimo. El largo de la manija decide el ancho: `ancho` grande da
    festones anchos y uniones entre dientes afiladas; chico, al revés. Un controlador puede
    traer sus manijas puestas a mano (`propias[id] = {"a": [dx, dy, dz], "b": [...]}`), que
    pisan a las calculadas.
    """
    n = len(claves)
    res = np.zeros((n, 2, 3))
    for i in range(n):
        ant = claves[(i - 1) % n] if cerrada or i > 0 else claves[i]
        sig = claves[(i + 1) % n] if cerrada or i < n - 1 else claves[i]
        t = sig - ant
        t = t - (t @ arriba) * arriba                       # plana
        largo = np.linalg.norm(t)
        t = t / largo if largo > 1e-9 else np.zeros(3)
        if info[i]["clase"] == "inversa":
            f = max(ANCHO_TOTAL - ancho, 0.02)
        elif info[i]["tipo"] == "e":
            f = ANCHO_EXTREMO
        else:
            f = ancho
        res[i, 0] = claves[i] - t * f * np.linalg.norm(claves[i] - ant)
        res[i, 1] = claves[i] + t * f * np.linalg.norm(sig - claves[i])
        mias = propias.get(info[i].get("id")) or {}
        for k, lado in enumerate(("a", "b")):
            if mias.get(lado) is not None:
                res[i, k] = claves[i] + np.asarray(mias[lado], dtype=np.float64)
    return res


def _bezier(claves: np.ndarray, manijas: np.ndarray, cerrada: bool, por_tramo: int = 16) -> np.ndarray:
    """Una Bézier cúbica por tramo, de clave a clave, con las manijas como puntos de control."""
    n = len(claves)
    if n < 2:
        return claves.copy()
    t = np.linspace(0, 1, por_tramo, endpoint=False)[:, None]
    salida = []
    for i in range(n if cerrada else n - 1):
        j = (i + 1) % n
        p0, p1, p2, p3 = claves[i], manijas[i, 1], manijas[j, 0], claves[j]
        salida.append((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3)
    if not cerrada:
        salida.append(claves[-1][None, :])
    return np.vstack(salida)


def remuestrear(p: np.ndarray, cerrada: bool, n: int | None = None, paso: float | None = None) -> np.ndarray:
    """Reparte los puntos a distancia pareja: por cantidad (`n`) o por separación (`paso`)."""
    q = np.vstack([p, p[0]]) if cerrada else p
    largo = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1))])
    total = largo[-1]
    if total <= 0:
        return p.copy()
    if n is None:
        n = max(3, int(round(total / max(paso or 0.25, 1e-3))))
    s = np.linspace(0, total, n, endpoint=not cerrada)
    return np.column_stack([np.interp(s, largo, q[:, k]) for k in range(3)])


def largo_de(p: np.ndarray, cerrada: bool) -> float:
    q = np.vstack([p, p[0]]) if cerrada else p
    return float(np.linalg.norm(np.diff(q, axis=0), axis=1).sum())


def generar(malla: Malla, controladores: list[dict], offset: float = 0.0, amplitud: float = 0.0,
            n: int | None = 500, paso: float | None = None, ancho: float = ANCHO,
            inversas: dict | None = None) -> dict:
    """La curva de un movimiento, apoyada sobre su malla.

    controladores: [{id, tipo: 'v'|'l'|'e', pos: [x, y, z], manijas?: {a?, b?}, offset?: bool,
    festoneado?: bool}], en cualquier orden. inversas: {clave_inversa(a, b): [dx, dy, dz]}.
    Devuelve {cerrada, tramos: [{puntos, claves, info, manijas}], largo}. `claves` son las crestas
    y las crestas inversas sobre la malla, en el orden de la curva, y `manijas` sus dos manijas
    Bézier (sirven para dibujarlas y para agarrarlas).
    """
    orden = ordenar(controladores, malla.arriba)
    propias = {c["id"]: c["manijas"] for c in controladores if c.get("manijas")}
    tramos, total = [], 0.0
    for tramo in orden["tramos"]:
        claves, info = _claves(tramo, malla.arriba, offset, amplitud, orden["cerrada"], inversas)
        claves = malla.mas_cercano(claves)
        manijas = _manijas(claves, info, malla.arriba, float(ancho), propias, orden["cerrada"])
        fina = malla.mas_cercano(_bezier(claves, manijas, orden["cerrada"]))
        puntos = malla.mas_cercano(remuestrear(fina, orden["cerrada"], n=n, paso=paso))
        for _ in range(2):      # apoyar sobre la malla desparejó un poco el paso: se vuelve a repartir
            puntos = malla.mas_cercano(remuestrear(puntos, orden["cerrada"], n=len(puntos)))
        total += largo_de(puntos, orden["cerrada"])
        tramos.append({"puntos": puntos, "claves": claves, "info": info, "manijas": manijas})
    return {"cerrada": orden["cerrada"], "tramos": tramos, "largo": total}
