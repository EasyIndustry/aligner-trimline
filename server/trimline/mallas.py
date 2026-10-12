"""Mallas en memoria: se cargan una vez, se sueldan y quedan indexadas.

El navegador recibe exactamente los mismos vértices e índices que usa el servidor, así un clic
sobre la malla se entiende igual de los dos lados y la malla cruza la frontera una sola vez.
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field

import numpy as np
import trimesh
from scipy.spatial import cKDTree


@dataclass
class Malla:
    id: str
    nombre: str
    v: np.ndarray            # (N, 3) float32
    f: np.ndarray            # (M, 3) uint32
    arriba: np.ndarray       # (3,) unitario: de la base hacia los dientes
    base: float              # altura de la base sobre `arriba`
    _tri: np.ndarray = field(repr=False, default=None)
    _arbol: cKDTree = field(repr=False, default=None)

    def binario(self) -> bytes:
        """Cabecera (cantidad de vértices y de caras, uint32) + posiciones float32 + índices uint32."""
        cab = np.array([len(self.v), len(self.f)], dtype="<u4").tobytes()
        return cab + self.v.astype("<f4").tobytes() + self.f.astype("<u4").tobytes()

    def resumen(self) -> dict:
        return {
            "id": self.id,
            "nombre": self.nombre,
            "vertices": int(len(self.v)),
            "caras": int(len(self.f)),
            "arriba": [float(x) for x in self.arriba],
            "min": [float(x) for x in self.v.min(0)],
            "max": [float(x) for x in self.v.max(0)],
        }

    def mas_cercano(self, puntos: np.ndarray, k: int = 16) -> np.ndarray:
        """El punto de la superficie más cercano a cada punto dado.

        Busca entre los k triángulos de baricentro más próximo: alcanza porque la curva vive en
        la zona de encía y dientes, donde los triángulos son chicos y parejos.
        """
        p = np.atleast_2d(np.asarray(puntos, dtype=np.float64))
        if self._arbol is None:
            self._tri = self.v[self.f].astype(np.float64)
            self._arbol = cKDTree(self._tri.mean(axis=1))
        k = min(k, len(self.f))
        _, idx = self._arbol.query(p, k=k)
        idx = idx.reshape(len(p), k)
        cand = _punto_en_triangulo(np.repeat(p, k, axis=0), self._tri[idx.ravel()]).reshape(len(p), k, 3)
        d = np.linalg.norm(cand - p[:, None, :], axis=2)
        return cand[np.arange(len(p)), d.argmin(axis=1)]


def _punto_en_triangulo(p: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """Punto más cercano de cada triángulo a su punto (Ericson, Real-Time Collision Detection)."""
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = _dot(ab, ap), _dot(ac, ap)
    bp = p - b
    d3, d4 = _dot(ab, bp), _dot(ac, bp)
    cp = p - c
    d5, d6 = _dot(ab, cp), _dot(ac, cp)
    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4
    with np.errstate(divide="ignore", invalid="ignore"):
        den = va + vb + vc
        v = np.where(den != 0, vb / den, 0.0)
        w = np.where(den != 0, vc / den, 0.0)
        res = a + ab * v[:, None] + ac * w[:, None]                      # interior
        t_ab = np.where(d1 - d3 != 0, d1 / (d1 - d3), 0.0)
        t_ac = np.where(d2 - d6 != 0, d2 / (d2 - d6), 0.0)
        den_bc = (d4 - d3) + (d5 - d6)
        t_bc = np.where(den_bc != 0, (d4 - d3) / den_bc, 0.0)
    casos = [
        ((d1 <= 0) & (d2 <= 0), a),
        ((d3 >= 0) & (d4 <= d3), b),
        ((d6 >= 0) & (d5 <= d6), c),
        ((vc <= 0) & (d1 >= 0) & (d3 <= 0), a + ab * t_ab[:, None]),
        ((vb <= 0) & (d2 >= 0) & (d6 <= 0), a + ac * t_ac[:, None]),
        ((va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0), b + (c - b) * t_bc[:, None]),
    ]
    hecho = np.zeros(len(p), dtype=bool)
    for cond, valor in casos:
        usar = cond & ~hecho
        res[usar] = valor[usar]
        hecho |= cond
    return res


def _dot(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.einsum("ij,ij->i", x, y)


def _detectar_base(v: np.ndarray, f: np.ndarray) -> tuple[np.ndarray, float]:
    """La base plana del modelo: el mayor conjunto de caras coplanares.

    Devuelve `arriba` (de la base hacia los dientes) y la altura de la base sobre ese eje. Si el
    modelo no tiene base reconocible (un escaneo sin recortar), cae al eje de menor extensión.
    """
    tri = v[f].astype(np.float64)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(n, axis=1) / 2
    ok = area > 1e-12
    n = n[ok] / (2 * area[ok, None])
    area, centro = area[ok], tri[ok].mean(axis=1)
    claves = np.round(n * 20).astype(np.int64)                 # normales agrupadas cada ~3 grados
    _, inv = np.unique(claves, axis=0, return_inverse=True)
    inv = inv.ravel()
    peso = np.bincount(inv, weights=area)
    grupo = inv == peso.argmax()
    normal = (n[grupo] * area[grupo, None]).sum(axis=0)
    normal /= np.linalg.norm(normal)
    paralelas = n @ normal > 0.999
    d = centro[paralelas] @ normal
    hist, bordes = np.histogram(d, bins=max(8, int(np.ptp(d) / 0.05) + 1), weights=area[paralelas])
    i = hist.argmax()
    plano = (d >= bordes[i] - 0.05) & (d <= bordes[i + 1] + 0.05)
    area_base = area[paralelas][plano].sum()
    if area_base < 0.03 * area.sum():                          # sin base clara
        eje = np.eye(3)[np.ptp(v, axis=0).argmin()]
        return eje, float((v @ eje).min())
    punto = np.average(centro[paralelas][plano], axis=0, weights=area[paralelas][plano])
    arriba = -normal                                           # la normal de la base mira hacia afuera
    if (v.mean(axis=0) - punto) @ arriba < 0:
        arriba = -arriba
    return arriba, float(punto @ arriba)


_MALLAS: dict[str, Malla] = {}


def cargar(datos: bytes, nombre: str) -> Malla:
    """Carga un STL (u otro formato de malla que lea trimesh) y lo deja indexado en memoria."""
    ident = hashlib.sha1(datos).hexdigest()[:16]
    if ident in _MALLAS:
        return _MALLAS[ident]
    ext = nombre.rsplit(".", 1)[-1].lower() if "." in nombre else "stl"
    m = trimesh.load(io.BytesIO(datos), file_type=ext, force="mesh", process=True)
    if not isinstance(m, trimesh.Trimesh) or len(m.faces) == 0:
        raise ValueError(f"{nombre}: no es una malla con caras")
    v = np.asarray(m.vertices, dtype=np.float32)
    f = np.asarray(m.faces, dtype=np.uint32)
    arriba, base = _detectar_base(v, f)
    malla = Malla(id=ident, nombre=nombre, v=v, f=f, arriba=arriba.astype(np.float64), base=base)
    _MALLAS[ident] = malla
    return malla


def desde_binario(ident: str, nombre: str, datos: bytes, arriba, base: float) -> Malla:
    """Vuelve a cargar una malla guardada con `binario()`, con su id y su base de antes."""
    if ident in _MALLAS:
        return _MALLAS[ident]
    nv, nf = np.frombuffer(datos[:8], dtype="<u4")
    v = np.frombuffer(datos, dtype="<f4", count=int(nv) * 3, offset=8).reshape(-1, 3).copy()
    f = np.frombuffer(datos, dtype="<u4", count=int(nf) * 3, offset=8 + int(nv) * 12).reshape(-1, 3).copy()
    malla = Malla(id=ident, nombre=nombre, v=v, f=f, arriba=np.asarray(arriba, dtype=np.float64), base=float(base))
    _MALLAS[ident] = malla
    return malla


def obtener(ident: str) -> Malla:
    try:
        return _MALLAS[ident]
    except KeyError:
        raise KeyError(f"malla {ident} no está cargada") from None


def descartar(ident: str) -> None:
    _MALLAS.pop(ident, None)
