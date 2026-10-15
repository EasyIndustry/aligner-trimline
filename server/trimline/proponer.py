"""Propone los puntos de control de la curva a partir de una segmentación de dientes.

Las etiquetas son las de teethseg (run_segment.py): una por cara del STL, 0 = encía y 1..N las
piezas en orden de arco. No se arma la curva directa: el borde de la segmentación no es preciso.
Se proponen los mismos puntos que se marcan a mano y la curva la resuelve el programa como siempre:

- vestibular y lingual de cada pieza: el punto más apical del borde diente/encía de ese lado, en el
  tercio central de la pieza (el cenit gingival); los festones y las papilas los pone la curva;
- extremos: el punto del borde más distal de la primera y la última pieza.

Una pieza partida en dos da un punto de más (se borra con un clic); una que falta, un hueco.
"""
from __future__ import annotations

import io
import json

import numpy as np
import trimesh

from .mallas import Malla

MIN_CARAS = 300          # piezas más chicas no son dientes (restos del corte)
TERCIO = 0.35            # cuánto del ancho de la pieza, a cada lado del centro, cuenta como "centro"


def borde_por_pieza(m: trimesh.Trimesh, lab: np.ndarray) -> dict[int, np.ndarray]:
    """Los vértices del borde entre cada pieza y la encía."""
    a = m.face_adjacency
    la, lb = lab[a[:, 0]], lab[a[:, 1]]
    cruza = (la == 0) != (lb == 0)
    pieza = np.where(la[cruza] == 0, lb[cruza], la[cruza])
    aristas = m.face_adjacency_edges[cruza]
    return {int(k): np.unique(aristas[pieza == k].ravel()) for k in np.unique(pieza)}


def proponer(malla: Malla, lab: np.ndarray) -> list[dict]:
    """[{id, tipo, pos, pieza}] en el orden del arco."""
    m = trimesh.Trimesh(malla.v, malla.f, process=False)
    if len(lab) != len(m.faces):
        raise ValueError(f"las etiquetas son de otra malla: {len(lab)} contra {len(m.faces)} caras")
    arriba = malla.arriba
    altura = m.vertices @ arriba
    plano = lambda p: p - np.outer(p @ arriba, arriba) if p.ndim == 2 else p - (p @ arriba) * arriba

    piezas = [k for k in sorted(set(np.unique(lab)) - {0}) if (lab == k).sum() >= MIN_CARAS]
    bordes = borde_por_pieza(m, lab)
    piezas = [k for k in piezas if k in bordes and len(bordes[k]) >= 10]
    centros = {k: m.triangles_center[lab == k].mean(axis=0) for k in piezas}
    centro_arco = plano(np.mean([centros[k] for k in piezas], axis=0))

    ctrl, n = [], 0
    def poner(tipo, p, pieza):
        nonlocal n
        n += 1
        ctrl.append({"id": f"auto{n}", "tipo": tipo, "pos": [float(x) for x in p], "pieza": int(pieza)})

    for i, k in enumerate(piezas):
        c = centros[k]
        ant = centros[piezas[max(i - 1, 0)]]
        sig = centros[piezas[min(i + 1, len(piezas) - 1)]]
        t = plano(sig - ant)
        t /= np.linalg.norm(t)
        afuera = np.cross(arriba, t)
        if afuera @ (plano(c) - centro_arco) < 0:
            afuera = -afuera
        v = m.vertices[bordes[k]]
        a_lo_largo = (v - c) @ t
        ancho = np.ptp(a_lo_largo)
        central = np.abs(a_lo_largo - np.median(a_lo_largo)) <= TERCIO * ancho
        for tipo, lado in (("v", 1), ("l", -1)):
            ok = central & (lado * ((v - c) @ afuera) > 0)
            if ok.sum() < 3:
                continue
            idx = bordes[k][ok]
            poner(tipo, m.vertices[idx[np.argmin(altura[idx])]], k)   # el más apical: el cenit
        if i in (0, len(piezas) - 1):
            distal = -t if i == 0 else t
            poner("e", v[np.argmax(v @ distal)], k)
    return ctrl


def leer_etiquetas(datos: bytes) -> np.ndarray:
    """Las etiquetas de teethseg: el `_etiquetas.json` ({labels: [...]}) o el `_labels_por_cara.npy`."""
    if datos[:6] == b"\x93NUMPY":
        return np.load(io.BytesIO(datos), allow_pickle=False).astype(np.int32).ravel()
    try:
        dato = json.loads(datos.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("no son etiquetas de teethseg (ni .npy ni .json)") from None
    lab = dato.get("labels") if isinstance(dato, dict) else dato
    if not isinstance(lab, list):
        raise ValueError("el .json no tiene 'labels'")
    return np.asarray(lab, dtype=np.int32)


