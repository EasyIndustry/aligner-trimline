"""Propone los puntos de control a partir del modelo, sin marcar nada a mano.

No arma la curva: propone los mismos puntos que se marcan a mano (vestibular y lingual de cada
diente y los dos extremos) y la curva la resuelve el programa como siempre.

Primero se SEGMENTA por la huella que deja el programa que exportó el modelo (`segmentar.py`:
bloques de índices, pliegue diente-encía o remesh): da cada diente con sus caras, y el punto de
cada lado es el más apical de su borde con la encía, en el tercio central (el cenit gingival);
los extremos, lo más distal del borde del primero y del último.

Si el modelo no trae huella (o sale una segmentación poco creíble), se busca por GEOMETRÍA, que
anda con cualquier modelo:

1. si el archivo trae varias mallas (cuerpos sueltos: un cartel, un soporte), se trabaja sobre
   la más grande;
2. la LÍNEA MEDIA de la arcada: por sector angular alrededor del centro, el radio de lo más alto
   (las coronas);
3. un CORTE perpendicular a la arcada cada medio milímetro; en cada uno se baja desde lo más alto
   de la corona por afuera (vestibular) y por adentro (lingual), y los pliegues cóncavos del
   perfil son los candidatos a MARGEN GINGIVAL;
4. de corte a corte se elige el candidato que deja la línea del margen más continua (Viterbi):
   un pliegue suelto no la hace saltar;
5. los DIENTES se separan donde el margen sube (papila) y la corona baja (tronera); el punto de
   cada diente es el más apical de su margen, en el tercio central (el cenit gingival);
6. los EXTREMOS: el pliegue bajando hacia distal, en un corte a lo largo de la punta de la arcada.
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp
from scipy.ndimage import gaussian_filter1d
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from .curva import _base_plana
from .mallas import Malla

PASO = 0.5               # mm entre cortes, a lo largo de la arcada
PASO_PERFIL = 0.15       # mm entre puntos del perfil de cada corte
RADIO = 16.0             # mm alrededor de la línea media que entran en un corte
BAJADA = 16.0            # mm de perfil que se recorren desde lo más alto de la corona
CAIDA_MIN = 1.5          # mm: más arriba que esto no puede estar el margen
ESCALA = 0.6             # mm: tamaño del pliegue que se mide
UMBRAL = 0.12            # rad: un pliegue menos marcado no es candidato
SALTO = 0.6              # castigo por mm que el margen salta de un corte al siguiente
DIENTE_MIN = 4.5         # mm: dos separaciones entre dientes no pueden estar más cerca


def cuerpo_mayor(f: np.ndarray, nv: int) -> tuple[np.ndarray, int]:
    """Las caras de la malla conexa más grande y cuántos cuerpos trae el archivo."""
    e = np.r_[f[:, [0, 1]], f[:, [1, 2]]].astype(np.int64)
    g = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), (nv, nv))
    n, lab = connected_components(g, directed=False)
    lf = lab[f[:, 0]]
    tam = np.bincount(lf)
    return lf == tam.argmax(), int((tam > 0).sum())


def linea_media(v: np.ndarray, arriba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """La línea media de las coronas, de una punta de la arcada a la otra, cada PASO mm.

    Devuelve los puntos (K, 3) y el centro de la arcada en el plano (e1, e2).
    """
    e1, e2 = _base_plana(arriba)
    h = v @ arriba
    p = np.c_[v @ e1, v @ e2]
    centro = p[h > np.median(h)].mean(0)
    d = p - centro
    nb = 180
    sector = ((np.arctan2(d[:, 1], d[:, 0]) + np.pi) / (2 * np.pi) * nb).astype(int) % nb
    radio = np.hypot(d[:, 0], d[:, 1])
    rad, alt = np.full(nb, np.nan), np.full(nb, np.nan)
    orden = np.argsort(sector)
    limites = np.searchsorted(sector[orden], np.arange(nb + 1))
    for k in range(nb):
        s = orden[limites[k]:limites[k + 1]]
        if len(s) < 20:
            continue
        top = h[s] >= h[s].max() - 1.5
        rad[k] = np.median(radio[s][top])
        alt[k] = h[s].max()
    hay = ~np.isnan(rad)
    # la corrida más larga de sectores con coronas: el hueco que queda es la boca de la U
    mejor = ini = corrida = desde = 0
    for i, x in enumerate(np.r_[hay, hay]):
        if not x:
            corrida = 0
            continue
        if corrida == 0:
            desde = i
        corrida += 1
        if mejor < corrida <= nb:
            mejor, ini = corrida, desde
    if mejor < 10:
        raise ValueError("no se reconoce una arcada en el modelo")
    idx = (ini + np.arange(mejor)) % nb
    ang = (idx + 0.5) / nb * 2 * np.pi - np.pi
    rr = gaussian_filter1d(rad[idx], 1.5, mode="nearest")
    hh = gaussian_filter1d(alt[idx], 1.5, mode="nearest")
    q = centro + np.c_[np.cos(ang), np.sin(ang)] * rr[:, None]
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1))]
    ss = np.arange(0, s[-1], PASO)
    q = np.c_[np.interp(ss, s, q[:, 0]), np.interp(ss, s, q[:, 1])]
    pts = np.outer(q[:, 0], e1) + np.outer(q[:, 1], e2) + np.outer(np.interp(ss, s, hh), arriba)
    return pts, centro


class Cortes:
    """Cortes de la malla con planos, cerca de un punto, encadenados en polilíneas."""

    def __init__(self, v: np.ndarray, f: np.ndarray):
        self.v = v.astype(np.float64)
        self.f = f.astype(np.int64)
        self.arbol = cKDTree(self.v[self.f].mean(1))

    def cadenas(self, o: np.ndarray, normal: np.ndarray, radio: float = RADIO) -> list[np.ndarray]:
        caras = np.array(self.arbol.query_ball_point(o, radio), dtype=np.int64)
        if not len(caras):
            return []
        F = self.f[caras]
        d = (self.v[F] - o) @ normal
        d[d == 0] = 1e-9
        arriba = d > 0
        cruza = arriba.any(1) & ~arriba.all(1)
        F, d = F[cruza], d[cruza]
        if not len(F):
            return []
        # cada cara cruzada aporta un segmento entre sus dos aristas cortadas; la arista (par de
        # vértices) identifica el punto, así los segmentos se encadenan sin tolerancias
        pts, claves, corta = [], [], []
        for i, j in ((0, 1), (1, 2), (2, 0)):
            with np.errstate(divide="ignore", invalid="ignore"):     # aristas que no cortan
                t = d[:, i] / (d[:, i] - d[:, j])
            with np.errstate(invalid="ignore"):
                pts.append(self.v[F[:, i]] + (self.v[F[:, j]] - self.v[F[:, i]]) * t[:, None])
            a, b = np.minimum(F[:, i], F[:, j]), np.maximum(F[:, i], F[:, j])
            claves.append(a * (len(self.v) + 1) + b)
            corta.append((d[:, i] > 0) != (d[:, j] > 0))
        pts, claves, corta = np.stack(pts, 1), np.stack(claves, 1), np.stack(corta, 1)
        dos = corta.sum(1) == 2
        pts, claves, corta = pts[dos], claves[dos], corta[dos]
        primera = corta.argmax(1)
        segunda = 2 - corta[:, ::-1].argmax(1)
        r = np.arange(len(pts))
        ka, kb = claves[r, primera], claves[r, segunda]
        donde = {}
        vecinos: dict[int, list[int]] = {}
        for a, b, pa, pb in zip(ka.tolist(), kb.tolist(), pts[r, primera], pts[r, segunda]):
            donde[a], donde[b] = pa, pb
            vecinos.setdefault(a, []).append(b)
            vecinos.setdefault(b, []).append(a)
        vistos: set[int] = set()
        out = []
        puntas = [k for k, l in vecinos.items() if len(l) == 1]
        for inicio in puntas + list(vecinos):
            if inicio in vistos:
                continue
            cadena = [inicio]
            vistos.add(inicio)
            while True:
                sig = [x for x in vecinos[cadena[-1]] if x not in vistos]
                if not sig:
                    break
                vistos.add(sig[0])
                cadena.append(sig[0])
            if len(cadena) > 3:
                p = np.array([donde[k] for k in cadena])
                if inicio in vecinos[cadena[-1]]:
                    p = np.r_[p, p[:1]]
                out.append(p)
        return out


def _remuestrear(p: np.ndarray, paso: float) -> tuple[np.ndarray, np.ndarray]:
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
    if s[-1] < paso * 3:
        return p, s
    ss = np.arange(0, s[-1], paso)
    return np.stack([np.interp(ss, s, p[:, i]) for i in range(3)], 1), ss


def bajada(cortes: Cortes, o: np.ndarray, normal: np.ndarray, afuera: np.ndarray,
           arriba: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """El perfil del corte desde lo más alto de la corona, bajando hacia `afuera`.

    Devuelve los puntos 3D y sus coordenadas (cuánto hacia afuera, altura) relativas a `o`.
    """
    mejor = None
    for p in cortes.cadenas(o, normal):
        rel = p - o
        u, h = rel @ afuera, rel @ arriba
        cerca = np.abs(u) < 6
        if cerca.any():
            top = np.where(cerca)[0][np.argmax(h[cerca])]
            if mejor is None or h[top] > mejor[2]:
                mejor = (p, top, h[top])
    if mejor is None:
        return None
    p, top, _ = mejor
    cerrada = np.allclose(p[0], p[-1])
    base = p[:-1] if cerrada else p
    n = len(base)
    caminos = []
    for sentido in (1, -1):
        idx, largo, i = [top], 0.0, top
        while largo < BAJADA and len(idx) <= n:
            j = i + sentido
            if cerrada:
                j %= n
            elif not 0 <= j < n:
                break
            largo += float(np.linalg.norm(base[j] - base[i]))
            idx.append(j)
            i = j
        caminos.append(base[idx])
    def hacia_afuera(c):
        k = min(len(c) - 1, max(3, len(c) // 4))
        return float((c[k] - c[0]) @ afuera)
    camino, _ = _remuestrear(max(caminos, key=hacia_afuera), PASO_PERFIL)
    rel = camino - o
    return camino, np.c_[rel @ afuera, rel @ arriba]


def _concavidad(uh: np.ndarray) -> np.ndarray:
    """Cuánto dobla el perfil en cada punto (rad): positivo es un pliegue hacia adentro."""
    k = max(1, int(round(ESCALA / PASO_PERFIL)))
    out = np.zeros(len(uh))
    if len(uh) <= 2 * k:
        return out
    d1 = uh[k:-k] - uh[:-2 * k]
    d2 = uh[2 * k:] - uh[k:-k]
    out[k:-k] = np.arctan2(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0], (d1 * d2).sum(1))
    return out


def candidatos(cortes, o, normal, afuera, arriba) -> dict | None:
    """Los pliegues del perfil que pueden ser el margen gingival, con cuán marcados están."""
    b = bajada(cortes, o, normal, afuera, arriba)
    if b is None or len(b[0]) < 10:
        return None
    camino, uh = b
    cv = _concavidad(uh)
    ok = uh[0, 1] - uh[:, 1] >= CAIDA_MIN
    pico = np.r_[False, (cv[1:-1] >= cv[:-2]) & (cv[1:-1] >= cv[2:]), False]
    js = np.where(ok & pico & (cv > UMBRAL))[0]
    if not len(js):
        js = np.where(ok)[0]
        if not len(js):
            return None
        js = js[[np.argmax(cv[js])]]
    return {"p": camino[js], "f": cv[js], "top": camino[0]}


def _continua(cands: list[dict | None]) -> list[np.ndarray | None]:
    """Un candidato por corte: los más marcados, sin que la línea salte (Viterbi)."""
    idx = [i for i, c in enumerate(cands) if c is not None]
    if not idx:
        return [None] * len(cands)
    costo = {idx[0]: -cands[idx[0]]["f"]}
    atras = {}
    for prev, i in zip(idx, idx[1:]):
        d = np.linalg.norm(cands[i]["p"][:, None] - cands[prev]["p"][None], axis=2)
        tot = costo[prev][None, :] + SALTO * np.maximum(0, d - (i - prev) * PASO - 0.4)
        atras[i] = tot.argmin(1)
        costo[i] = tot.min(1) - cands[i]["f"]
    sel: list[np.ndarray | None] = [None] * len(cands)
    j = int(np.argmin(costo[idx[-1]]))
    for k in range(len(idx) - 1, -1, -1):
        i = idx[k]
        sel[i] = cands[i]["p"][j]
        if k:
            j = int(atras[i][j])
    return sel


def _rellenar(x: np.ndarray) -> np.ndarray:
    ok = ~np.isnan(x)
    if ok.sum() < 2:
        return np.zeros_like(x)
    return np.interp(np.arange(len(x)), np.where(ok)[0], x[ok])


PUNTAJE_MIN = 0.5        # una segmentación por huella con menos puntaje no se usa
TERCIO = 0.35            # cuánto del ancho del diente, a cada lado del centro, cuenta como "centro"


def por_huella(malla: Malla) -> dict | None:
    """Puntos desde la segmentación por huella, o None si no hay una creíble."""
    import trimesh

    from . import segmentar as S

    m = trimesh.Trimesh(malla.v, malla.f, process=False)     # sin reordenar: el orden es la huella
    try:
        seg, estrategia, diag = S.segmentar(m)
    except (S.Hueco, S.Desmontado) as e:
        # una pieza ya exportada (hueca) o con los dientes sueltos: ahí una curva no tiene sentido
        raise ValueError(f"este modelo no sirve para proponer puntos: {e}") from None
    except ValueError:                                         # sin huella: se busca por geometría
        return None
    if diag[estrategia]["puntaje"] < PUNTAJE_MIN:
        return None
    seg = S.numerar_por_arco(m, seg)
    arriba = malla.arriba
    altura = m.vertices @ arriba
    plano = lambda p: p - np.outer(p @ arriba, arriba) if p.ndim == 2 else p - (p @ arriba) * arriba
    adj = m.face_adjacency
    la, lb = seg[adj[:, 0]], seg[adj[:, 1]]
    cruza = (la >= 0) != (lb >= 0)
    contra = np.where(la[cruza] >= 0, lb[cruza], la[cruza])
    pieza = np.where(la[cruza] >= 0, la[cruza], lb[cruza])[contra == S.ENCIA]
    aristas = m.face_adjacency_edges[cruza][contra == S.ENCIA]
    n = int(seg.max() + 1)
    bordes = {k: np.unique(aristas[pieza == k].ravel()) for k in range(n)}
    piezas = [k for k in range(n) if len(bordes[k]) >= 10]
    if len(piezas) < 2:
        return None
    centros = {k: m.triangles_center[seg == k].mean(0) for k in piezas}
    centro = plano(np.mean([centros[k] for k in piezas], 0))
    propuesta = []
    for i, k in enumerate(piezas):
        c = centros[k]
        t = plano(centros[piezas[min(i + 1, len(piezas) - 1)]] - centros[piezas[max(i - 1, 0)]])
        t /= np.linalg.norm(t)
        afuera = np.cross(arriba, t)
        if afuera @ (plano(c) - centro) < 0:
            afuera = -afuera
        v = m.vertices[bordes[k]]
        a_lo_largo = (v - c) @ t
        central = np.abs(a_lo_largo - np.median(a_lo_largo)) <= TERCIO * np.ptp(a_lo_largo)
        for tipo, lado in (("v", 1), ("l", -1)):
            ok = central & (lado * ((v - c) @ afuera) > 0)
            if ok.sum() >= 3:
                idx = bordes[k][ok]
                propuesta.append({"tipo": tipo, "pos": m.vertices[idx[np.argmin(altura[idx])]]})
        if i in (0, len(piezas) - 1):
            propuesta.append({"tipo": "e", "pos": v[np.argmax(v @ (-t if i == 0 else t))]})
    margen = [{"tipo": "limite", "pts": m.vertices[lazo]} for lazo in S.limite_gingival(m, seg)]
    return {"propuesta": propuesta, "margen": margen, "dientes": len(piezas), "etiquetas": seg,
            "metodo": f"huella ({estrategia})"}


def proponer(malla: Malla, detalle: bool = False) -> dict:
    """{propuesta: [{id, tipo, pos}], margen: [{tipo, pts}], dientes, cuerpos, metodo}.

    Si se segmentó por huella, `etiquetas` (por cara: 0.. dientes, -1 encía, -2 attachment,
    -3 base) queda en la malla para pintarla.
    """
    usar, cuerpos = cuerpo_mayor(malla.f, len(malla.v))
    r = None if detalle else por_huella(malla)
    if r is None:
        r = por_geometria(malla, usar, detalle)
    malla.etiquetas = r.pop("etiquetas", None)
    for k, p in enumerate(r["propuesta"]):
        p["id"] = f"auto{k + 1}"
        p["pos"] = [round(float(x), 4) for x in p["pos"]]
    r["margen"] = [{"tipo": l["tipo"], "pts": np.round(np.asarray(l["pts"], dtype=float), 4).tolist()}
                   for l in r["margen"] if len(l["pts"]) >= 2]
    r["cuerpos"] = cuerpos
    r["segmentado"] = malla.etiquetas is not None
    return r


def por_geometria(malla: Malla, usar: np.ndarray, detalle: bool = False) -> dict:
    """Puntos desde la forma: cortes a lo largo de la arcada (ver el principio del archivo).

    Con `detalle`, también lo que se usó para separar los dientes (para mirarlo): la línea media,
    los cortes que limitan cada diente, la altura del margen y las caras del cuerpo analizado.
    """
    arriba = malla.arriba
    f = malla.f[usar]
    A, centro = linea_media(malla.v[np.unique(f)].astype(np.float64), arriba)
    e1, e2 = _base_plana(arriba)
    cortes = Cortes(malla.v, f)
    n = len(A)
    T, O = [], []
    for i in range(n):
        t = A[min(i + 1, n - 1)] - A[max(i - 1, 0)]
        t -= (t @ arriba) * arriba
        t /= np.linalg.norm(t)
        afuera = np.cross(arriba, t)
        if (np.array([A[i] @ e1, A[i] @ e2]) - centro) @ np.array([afuera @ e1, afuera @ e2]) < 0:
            afuera = -afuera
        T.append(t)
        O.append(afuera)
    cv = [candidatos(cortes, A[i], T[i], O[i], arriba) for i in range(n)]
    cl = [candidatos(cortes, A[i], T[i], -O[i], arriba) for i in range(n)]
    lados = {"v": _continua(cv), "l": _continua(cl)}
    altura = {k: _rellenar(np.array([np.nan if p is None else p @ arriba for p in ms])) for k, ms in lados.items()}
    corona = _rellenar(np.array([max([c["top"] @ arriba for c in (cv[i], cl[i]) if c is not None], default=np.nan)
                                 for i in range(n)]))
    # entre dientes el margen sube (papila) y la corona baja (tronera)
    sep = gaussian_filter1d((altura["v"] + altura["l"]) / 2, 1.5) - gaussian_filter1d(corona, 1.5)
    w = int(DIENTE_MIN / PASO)
    picos = [i for i in range(w // 2, n - w // 2) if sep[i] == sep[max(0, i - w):i + w + 1].max()]
    limites = [0] + picos + [n - 1]
    propuesta, dientes = [], 0
    for a, b in zip(limites, limites[1:]):
        if b - a < 6:
            continue
        dientes += 1
        lo, hi = a + int(0.25 * (b - a)), b - int(0.25 * (b - a))
        for tipo, ms in lados.items():
            cand = [i for i in range(lo, hi + 1) if ms[i] is not None]
            if cand:
                i = min(cand, key=lambda i: ms[i] @ arriba)      # el más apical: el cenit
                propuesta.append({"tipo": tipo, "pos": ms[i]})
    for i, sentido in ((0, -1), (n - 1, 1)):
        o = A[i] - sentido * T[i] * 3.0
        c = candidatos(cortes, o, O[i], sentido * T[i], arriba)
        if c is not None:
            propuesta.append({"tipo": "e", "pos": c["p"][int(np.argmax(c["f"]))]})
    margen = [{"tipo": k, "pts": [p for p in ms if p is not None]} for k, ms in lados.items()]
    r = {"propuesta": propuesta, "margen": margen, "dientes": dientes, "metodo": "geometría"}
    if detalle:
        r["detalle"] = {"linea": A, "limites": limites, "altura": altura, "caras": usar, "afuera": np.array(O)}
    return r
