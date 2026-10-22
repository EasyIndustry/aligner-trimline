# Copia de workflow-bot-plugins/pre/segmentacion_gingival/segmentar.py (2026-10-22), que se
# desarrolla allá: los cambios se hacen allá y se vuelven a copiar. Acá solo se sacó la lectura
# de VRML (el programa no la usa). La usa proponer.py.
"""
Segmentación ficticia de una arcada y su límite gingival, sin red neuronal:
lee la huella que deja el software dental al exportar un modelo ya segmentado.

PRE-PLUGIN: no está en ninguna rama. Se prueba primero en aligner-trimline.

Es para los modelos legacy (~30 %): un solo cuerpo en STL. Los que vienen
desmontados (dientes como cuerpos separados, con raíces, ej. BX087) ya los
resuelve el software automático de la curva y acá se rechazan.

Tres estrategias. Con `auto` (sin interacción) corren todas, cada una se
puntúa (cantidad de dientes, encía dominante, límite en pocos lazos y sin
zigzag) y gana la mejor:

  pliegue  Cada diente está rodeado por un anillo continuo de aristas con ángulo
           diedro alto: la unión diente-encía que dejó el software. Cortando ahí
           salen encía, dientes, attachments y la base/zócalo (material extra de
           los modelos sólidos de impresión), cada uno como componente. Por
           superficie: < AREA_ATTACHMENT_MAX attachment, > AREA_DIENTE_MAX base
           (salvo la encía, que es la grande que más toca a los dientes).
           Ej. BZ254-*-solido, BY470.
  indices  Un solo cuerpo, pero el archivo guarda la encía y después cada diente
           en un bloque de índices contiguo, seguido de su attachment (export del
           Orthoanalyzer con textura, ej. AP962 .vrml). Dos caras vecinas del
           mismo bloque están a menos de SALTO_INDICE posiciones.
  area     Un solo cuerpo remesheado en barridos (Type3, ej. BY470): dientes con
           malla fina, encía gruesa y un anillo de costura más fino alrededor de
           cada diente. Los umbrales están calibrados con UN caso.

El límite gingival son las aristas entre caras de encía y del resto (dientes y
attachments), ordenadas en lazos.

Uso:
    python segmentar.py <modelo.stl|.ply|.obj|.vrml|.wrl> <carpeta salida> [auto|pliegue|indices|area]

Deja <stem>-segmentado.ply (color por cara), <stem>-segmentado.png,
<stem>-limite<N>.pts (un lazo por archivo, "x y z") y por_segmento/*.stl.
"""

from __future__ import annotations

import pathlib
import sys

import networkx as nx
import numpy as np
import scipy.sparse as sp
import trimesh
from scipy.sparse.csgraph import connected_components


SALTO_INDICE = 1000      # índices: vecinos del mismo bloque
MIN_BLOQUE = 300         # caras: menos que esto se absorbe en el vecino
DIENTES_MIN, DIENTES_MAX = 6, 20
AREA_DIENTE = 0.03       # área: mm², por debajo es diente (remesh fino)
AREA_COSTURA = 0.006     # área: mm², por debajo es la costura entre piezas
PLIEGUE = 40.0           # pliegue: grados de diedro donde se corta
AREA_ATTACHMENT_MAX = 25.0   # pliegue: mm² de superficie, menos es attachment
AREA_DIENTE_MAX = 300.0      # pliegue: mm², más es base / zócalo / encía
CUERPOS_DESMONTADO = 6   # cuerpos de más de AREA_ATTACHMENT_MAX mm²: desmontado
HUECO_V_A = 1.4          # mm, volumen/superficie: menos es una pieza ya exportada (hueca, ~0,85);
                         # los modelos de entrada dan 2,2-2,9

ENCIA, ATTACHMENT, BASE = -1, -2, -3


def leer(ruta: pathlib.Path) -> trimesh.Trimesh:
    """La malla SIN reordenar ni unir vértices: el orden es la huella."""
    if ruta.suffix.lower() in (".vrml", ".wrl"):
        import vrml  # al lado de este archivo, en pre/; el programa no lee VRML
        v, f, _, _ = vrml.leer(ruta)
        return trimesh.Trimesh(v, f, process=False)
    m = trimesh.load(ruta, process=False, force="mesh")
    if ruta.suffix.lower() == ".stl":
        # STL es sopa de triángulos: unir vértices sin tocar el orden de las caras
        m.merge_vertices()
    return m


def _componentes(F: int, aristas: np.ndarray) -> np.ndarray:
    g = sp.coo_matrix((np.ones(len(aristas)), (aristas[:, 0], aristas[:, 1])), (F, F))
    return connected_components(g, directed=False)[1]


def _vecinos(m: trimesh.Trimesh) -> sp.csr_matrix:
    adj = m.face_adjacency
    A = sp.coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), (len(m.faces),) * 2)
    return (A + A.T).tocsr()


def _absorber_chicas(lab: np.ndarray, A: sp.csr_matrix, minimo: int = MIN_BLOQUE) -> np.ndarray:
    lab = lab.copy()
    for _ in range(30):
        t = np.bincount(lab)
        chica = np.where(t[lab] < minimo)[0]
        if not len(chica):
            break
        for i in chica:
            vec = lab[A[i].indices]
            vec = vec[t[vec] >= minimo]
            if len(vec):
                lab[i] = np.bincount(vec).argmax()
    return lab


def _etiquetar(m: trimesh.Trimesh, lab: np.ndarray, encia: int) -> np.ndarray:
    """De componentes a etiquetas: 0..n dientes, ENCIA, ATTACHMENT (malla mucho más fina)."""
    a = m.area_faces
    out = np.full(len(lab), ENCIA)
    otros = [k for k in np.unique(lab) if k != encia]
    med = {k: np.median(a[lab == k]) for k in otros}
    ref = np.median(list(med.values())) if med else 0
    orden = sorted(otros, key=lambda k: np.where(lab == k)[0].min())
    j = 0
    for k in orden:
        if med[k] < 0.3 * ref:
            out[lab == k] = ATTACHMENT
        else:
            out[lab == k] = j
            j += 1
    return out


def cuerpos_grandes(m: trimesh.Trimesh) -> int:
    """Cuántos cuerpos de más de AREA_ATTACHMENT_MAX mm² tiene (las letras grabadas o un
    attachment suelto no cuentan): CUERPOS_DESMONTADO o más = dientes desmontados."""
    lab = _componentes(len(m.faces), m.face_adjacency)
    sup = np.bincount(lab, weights=m.area_faces)
    return int((sup > AREA_ATTACHMENT_MAX).sum())


def _clasificar(m: trimesh.Trimesh, lab: np.ndarray) -> np.ndarray | None:
    """
    De componentes a etiquetas, por superficie y posición (sirve para pliegue e índices):
    < AREA_ATTACHMENT_MAX attachment; entre eso y AREA_DIENTE_MAX diente; la grande que más
    toca a los dientes es la encía; las otras grandes, y lo que queda del otro lado de la
    encía respecto de los dientes (zócalo, base CNC, recortes), BASE.
    """
    F = len(lab)
    adj = m.face_adjacency
    sup = np.bincount(lab, weights=m.area_faces)
    vivas = np.unique(lab)
    cand = [k for k in vivas if AREA_ATTACHMENT_MAX <= sup[k] <= AREA_DIENTE_MAX]
    grandes = [k for k in vivas if sup[k] > AREA_DIENTE_MAX]
    if not grandes or len(cand) < DIENTES_MIN:
        return None
    es = np.isin(lab, cand)
    toca = adj[es[adj[:, 0]] != es[adj[:, 1]]].ravel()
    otros = lab[toca][~es[toca]]
    encia = max(grandes, key=lambda k: int((otros == k).sum()))
    up = _vertical(m)
    c = m.triangles_center[:, up]
    h_enc = np.median(c[lab == encia])
    h = {k: np.median(c[lab == k]) for k in cand}
    lado = np.sign(np.median([h[k] - h_enc for k in cand]))
    dientes_k = [k for k in cand if (h[k] - h_enc) * lado > 0]
    # sobre el arco: lo que cae cerca del centro (letras grabadas, marcas) no es diente
    if dientes_k:
        ej = [i for i in range(3) if i != up]
        xy = {k: np.median(m.triangles_center[lab == k][:, ej], 0) for k in dientes_k}
        P = np.array(list(xy.values()))
        ctr = (P.min(0) + P.max(0)) / 2  # centro de la caja: en una U la mediana cae sobre los incisivos
        r = {k: np.linalg.norm(xy[k] - ctr) for k in dientes_k}
        rm = np.median(list(r.values()))
        dientes_k = [k for k in dientes_k if r[k] > 0.4 * rm]
    seg = np.full(F, ATTACHMENT)
    seg[lab == encia] = ENCIA
    for k in grandes:
        if k != encia:
            seg[lab == k] = BASE
    for k in cand:
        if k not in dientes_k:
            seg[lab == k] = BASE
    orden = sorted(dientes_k, key=lambda k: np.where(lab == k)[0].min())
    for j, k in enumerate(orden):
        seg[lab == k] = j
    if not DIENTES_MIN <= len(orden) <= DIENTES_MAX:
        return None
    return _rellenar_islas(m, seg)


def _rellenar_islas(m: trimesh.Trimesh, seg: np.ndarray) -> np.ndarray:
    """Pedazos de encía rodeados por un solo diente (oclusales planas, fosas) pasan al diente."""
    adj = m.face_adjacency
    g = seg == ENCIA
    lg = _componentes(len(seg), adj[g[adj[:, 0]] & g[adj[:, 1]]])
    tg = np.bincount(lg[g], minlength=lg.max() + 1)
    principal = tg.argmax()
    for k in np.where(tg > 0)[0]:
        if k == principal:
            continue
        caras = g & (lg == k)
        borde = adj[caras[adj[:, 0]] ^ caras[adj[:, 1]]].ravel()
        vec = seg[borde][~caras[borde]]
        dientes_v = np.unique(vec[vec >= 0])
        if len(dientes_v) == 1 and (vec >= 0).mean() > 0.9:
            seg[caras] = dientes_v[0]
    return seg


def por_pliegue(m: trimesh.Trimesh, grados: float = PLIEGUE) -> np.ndarray | None:
    lab = _componentes(len(m.faces), m.face_adjacency[np.degrees(m.face_adjacency_angles) < grados])
    return _clasificar(m, _absorber_chicas(lab, _vecinos(m)))


def por_indices(m: trimesh.Trimesh) -> np.ndarray | None:
    adj = m.face_adjacency
    lab = _componentes(len(m.faces), adj[np.abs(adj[:, 0] - adj[:, 1]) < SALTO_INDICE])
    return _clasificar(m, _absorber_chicas(lab, _vecinos(m)))


def por_area(m: trimesh.Trimesh) -> np.ndarray | None:
    F = len(m.faces)
    a = m.area_faces
    adj = m.face_adjacency
    A = _vecinos(m)
    deg = np.asarray(A.sum(1)).ravel()
    diente = a < AREA_DIENTE
    for _ in range(6):  # voto de mayoría con los vecinos
        diente = (A @ diente.astype(float) + diente) / (deg + 1) > 0.5
    nucleo = diente & (a > AREA_COSTURA)
    lab = _componentes(F, adj[nucleo[adj[:, 0]] & nucleo[adj[:, 1]]])
    t = np.bincount(lab[nucleo], minlength=lab.max() + 1)
    keep = [k for k in np.argsort(-t) if t[k] >= 1500]
    if not DIENTES_MIN <= len(keep) <= DIENTES_MAX:
        return None
    seg = np.full(F, ENCIA)
    for i, k in enumerate(keep):
        seg[nucleo & (lab == k)] = i
    for _ in range(200):  # la costura vuelve al diente vecino
        libre = diente & (seg < 0)
        if not libre.any():
            break
        c1 = adj[(seg[adj[:, 0]] >= 0) & libre[adj[:, 1]]]
        c2 = adj[(seg[adj[:, 1]] >= 0) & libre[adj[:, 0]]][:, ::-1]
        cand = np.vstack([c1, c2])
        if not len(cand):
            break
        seg[cand[:, 1]] = seg[cand[:, 0]]
    # islas de encía encerradas en un diente (oclusales con triángulos grandes)
    g = seg < 0
    lg = _componentes(F, adj[g[adj[:, 0]] & g[adj[:, 1]]])
    tg = np.bincount(lg[g], minlength=lg.max() + 1)
    principal = tg.argmax()
    for k in np.where(tg > 0)[0]:
        if k == principal:
            continue
        caras = np.where(g & (lg == k))[0]
        vec = seg[A[caras].indices]
        vec = vec[vec >= 0]
        if len(vec):
            seg[caras] = np.bincount(vec).argmax()
    return seg


ESTRATEGIAS = {
    # el ángulo del pliegue cambia entre modelos (en los inferiores el anillo es más suave): se prueban varios
    **{f"pliegue{g}": (lambda m, g=g: por_pliegue(m, g)) for g in (15, 20, 25, 30, 35, 40, 45)},
    "indices": por_indices,
    "area": por_area,
}


class Desmontado(ValueError):
    """El modelo trae los dientes como cuerpos separados: no es legacy."""


class Hueco(ValueError):
    """Es una pieza ya exportada (hueca, con placa y QR), no un modelo de entrada: la cara
    interna repite los dientes."""


def volumen_sobre_area(m: trimesh.Trimesh) -> float | None:
    """V/A del cuerpo más grande, en mm (None si no está cerrado)."""
    lab = _componentes(len(m.faces), m.face_adjacency)
    p = m.submesh([np.where(lab == np.bincount(lab).argmax())[0]], append=True)
    return abs(p.volume) / p.area if p.is_watertight else None


def _rugosidad(m: trimesh.Trimesh, lazo: np.ndarray) -> float:
    """Largo del lazo / largo del lazo suavizado (1 = liso; el zigzag de aristas da ~1,3-1,5)."""
    q = m.vertices[lazo[:-1]]
    k = 7
    suave = np.stack([np.convolve(np.r_[q[-k:, i], q[:, i], q[:k, i]], np.ones(2 * k + 1) / (2 * k + 1), "same")[k:-k]
                      for i in range(3)], 1)
    largo = lambda x: np.linalg.norm(np.diff(np.r_[x, x[:1]], axis=0), axis=1).sum()
    return float(largo(q) / max(largo(suave), 1e-9))


def puntaje(m: trimesh.Trimesh, seg: np.ndarray) -> tuple[float, dict]:
    """0..1: qué tan creíble es la segmentación como arcada (sin saber cuál es la buena)."""
    n = int(seg.max() + 1)
    encia = float((seg == ENCIA).sum() / max((seg != BASE).sum(), 1))
    lazos = limite_gingival(m, seg)
    largo = lambda l: float(np.linalg.norm(np.diff(m.vertices[l], axis=0), axis=1).sum())
    principales = [l for l in lazos if largo(l) > 20]
    rug = float(np.mean([_rugosidad(m, l) for l in principales])) if principales else 9.0
    s = 1.0
    s -= 0.08 * max(0, abs(n - 14) - 2)          # 12 a 16 dientes: sin castigo
    s -= 0.5 * max(0.0, 0.2 - encia) + 0.5 * max(0.0, encia - 0.7)
    # un lazo para toda la arcada (dientes que se tocan) o uno por diente: lo demás son pedazos
    s -= 0.1 * max(0, min(abs(len(principales) - 1), abs(len(principales) - n)) - 2)
    s -= 0.5 * max(0.0, rug - 1.0)                # zigzag
    if not principales:
        s = 0.0
    return max(0.0, s), {"dientes": n, "encia": round(encia, 2), "lazos": len(principales), "rugosidad": round(rug, 2)}


def segmentar(m: trimesh.Trimesh, estrategia: str = "auto") -> tuple[np.ndarray, str, dict]:
    if (va := volumen_sobre_area(m)) is not None and va < HUECO_V_A:
        raise Hueco(f"volumen/superficie {va:.2f} mm (< {HUECO_V_A}): es una pieza ya exportada, "
                    "hueca; hay que darle el modelo de entrada")
    if (nc := cuerpos_grandes(m)) >= CUERPOS_DESMONTADO:
        raise Desmontado(f"tiene {nc} cuerpos: viene desmontado (dientes separados), no es legacy; "
                         "va por el software automático de la curva")
    candidatas = {}
    elegidas = [k for k in ESTRATEGIAS if estrategia == "auto" or k.startswith(estrategia)]
    for nombre in elegidas:
        seg = ESTRATEGIAS[nombre](m)
        if seg is not None:
            candidatas[nombre] = (seg, *puntaje(m, seg))
    if not candidatas:
        raise ValueError("no se encontró la huella: ni bloques de índices ni remesh fino con "
                         f"una encía y entre {DIENTES_MIN} y {DIENTES_MAX} dientes")
    # A igual puntaje entre pliegues: la cantidad de dientes que más se repite entre los
    # ángulos (es la estable) y, de esos, el ángulo del medio.
    top = max(round(v[1], 2) for v in candidatas.values())
    empatadas = [k for k, v in candidatas.items() if round(v[1], 2) >= top - 0.02]
    pl = [k for k in empatadas if k.startswith("pliegue")]
    if len(pl) > 1 and len(pl) == len(empatadas):
        cuantos = [int(candidatas[k][0].max() + 1) for k in pl]
        n = max(set(cuantos), key=cuantos.count)
        pl = sorted((k for k, c in zip(pl, cuantos) if c == n), key=lambda k: int(k[7:]))
        mejor = pl[len(pl) // 2]
    else:
        mejor = max(empatadas, key=lambda k: candidatas[k][1])
    diagnostico = {k: {"puntaje": round(v[1], 2), **v[2]} for k, v in candidatas.items()}
    return candidatas[mejor][0], mejor, diagnostico


def limite_gingival(m: trimesh.Trimesh, seg: np.ndarray) -> list[np.ndarray]:
    """Lazos (índices de vértice, cerrados) entre la encía y el resto, del más largo al más corto."""
    g = seg == ENCIA
    pieza = (seg >= 0) | (seg == ATTACHMENT)
    adj = m.face_adjacency
    borde = m.face_adjacency_edges[(g[adj[:, 0]] & pieza[adj[:, 1]]) | (g[adj[:, 1]] & pieza[adj[:, 0]])]
    G = nx.Graph()
    G.add_edges_from(borde.tolist())
    lazos = []
    for comp in nx.connected_components(G):
        if len(comp) < 30:
            continue
        try:
            ciclo = [u for u, _ in nx.find_cycle(G.subgraph(comp))]
        except nx.NetworkXNoCycle:
            continue
        if len(ciclo) > 0.5 * len(comp):
            lazos.append(np.array(ciclo + ciclo[:1]))
    return sorted(lazos, key=len, reverse=True)


def _vertical(m: trimesh.Trimesh) -> int:
    """El eje de menor extensión de la arcada (oclusal), 0/1/2."""
    return int(np.argmin(m.triangles_center.std(0)))


def numerar_por_arco(m: trimesh.Trimesh, seg: np.ndarray) -> np.ndarray:
    """Renumera los dientes 0..n-1 de una punta del arco a la otra (no dice cuál es derecha)."""
    n = int(seg.max() + 1)
    if n < 2:
        return seg
    up = _vertical(m)
    ej = [k for k in range(3) if k != up]
    c = m.triangles_center
    cen = np.array([c[seg == i].mean(0)[ej] for i in range(n)])
    ang = np.arctan2(*(cen - cen.mean(0)).T[::-1])
    o = np.argsort(ang)
    # el arco arranca después del hueco angular más grande (la boca de la U)
    gaps = np.diff(np.r_[ang[o], ang[o[0]] + 2 * np.pi])
    o = np.roll(o, -(int(np.argmax(gaps)) + 1))
    nuevo = np.empty(n, int)
    nuevo[o] = np.arange(n)
    out = seg.copy()
    out[seg >= 0] = nuevo[seg[seg >= 0]]
    return out


def _cadenas(G: nx.Graph) -> list[list[int]]:
    """Las componentes de un grafo de aristas como polilíneas ordenadas (cerradas si son lazo)."""
    out = []
    for comp in nx.connected_components(G):
        H = G.subgraph(comp)
        puntas = [u for u in H if H.degree(u) == 1]
        orden = list(nx.dfs_preorder_nodes(H, puntas[0] if puntas else next(iter(H))))
        if not puntas:
            orden.append(orden[0])
        out.append(orden)
    return sorted(out, key=len, reverse=True)


def dientes(m: trimesh.Trimesh, seg: np.ndarray) -> list[dict]:
    """
    Por diente: centroide, base (centro de su borde con la encía), eje (base -> centroide),
    punta (lo más alto sobre el eje), caja, su tramo del límite gingival, vecinos y attachments.
    Sin ML: sale sólo de la segmentación.
    """
    adj = m.face_adjacency
    ae = m.face_adjacency_edges
    a = m.area_faces
    c = m.triangles_center
    V = m.vertices
    n = int(seg.max() + 1)
    # attachments: cada bloque va al diente con el que comparte más aristas
    att = seg == ATTACHMENT
    att_de = np.zeros(n, int)
    if att.any():
        lab = _componentes(len(seg), adj[att[adj[:, 0]] & att[adj[:, 1]]])
        for k in np.unique(lab[att]):
            caras = att & (lab == k)
            toca = adj[caras[adj[:, 0]] ^ caras[adj[:, 1]]].ravel()
            vec = seg[toca]
            vec = vec[vec >= 0]
            if len(vec):
                att_de[np.bincount(vec).argmax()] += 1
    out = []
    for i in range(n):
        caras = seg == i
        cen = (c[caras] * a[caras, None]).sum(0) / a[caras].sum()
        G = nx.Graph()
        G.add_edges_from(ae[(caras[adj[:, 0]] & (seg[adj[:, 1]] == ENCIA))
                            | (caras[adj[:, 1]] & (seg[adj[:, 0]] == ENCIA))].tolist())
        tramos = _cadenas(G) if len(G) else []
        borde = np.unique(np.concatenate(tramos)) if tramos else np.unique(m.faces[caras])
        base = V[borde].mean(0)
        eje = cen - base
        eje = eje / max(np.linalg.norm(eje), 1e-9)
        vs = np.unique(m.faces[caras])
        punta = V[vs[np.argmax(V[vs] @ eje)]]
        toca = adj[caras[adj[:, 0]] ^ caras[adj[:, 1]]].ravel()
        vec = sorted(int(x) for x in np.unique(seg[toca]) if x >= 0 and x != i)
        out.append({
            "id": i,
            "caras": int(caras.sum()),
            "centroide": cen.round(4).tolist(),
            "base": base.round(4).tolist(),
            "eje": eje.round(4).tolist(),
            "punta": punta.round(4).tolist(),
            "caja": [V[vs].min(0).round(4).tolist(), V[vs].max(0).round(4).tolist()],
            "limite": [V[t].round(4).tolist() for t in tramos],
            "vecinos": vec,
            "attachments": int(att_de[i]),
        })
    return out


def colores(seg: np.ndarray) -> np.ndarray:
    import matplotlib.pyplot as plt

    pal = (np.delete(plt.cm.tab20(np.arange(20)), [14, 15], 0)[:, :3] * 255).astype(np.uint8)
    col = pal[(np.maximum(seg, 0) * 7) % 18]
    col[seg == ENCIA] = (235, 160, 170)
    col[seg == ATTACHMENT] = (20, 20, 20)
    col[seg == BASE] = (110, 110, 120)
    return col


def exportar(m: trimesh.Trimesh, seg: np.ndarray, lazos: list[np.ndarray], stem: str,
             out: pathlib.Path, pts: np.ndarray | None = None, info: list[dict] | None = None) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out.mkdir(parents=True, exist_ok=True)
    col = colores(seg)
    mc = m.copy()
    mc.visual.face_colors = np.c_[col, np.full(len(col), 255, np.uint8)]
    mc.export(out / f"{stem}-segmentado.ply")
    (out / "por_segmento").mkdir(exist_ok=True)
    for k in np.unique(seg):
        nombre = {ENCIA: "encia", ATTACHMENT: "attachments", BASE: "base"}.get(k, f"diente{k:02d}")
        m.submesh([np.where(seg == k)[0]], append=True).export(out / "por_segmento" / f"{stem}-{nombre}.stl")
    for i, l in enumerate(lazos):
        np.savetxt(out / f"{stem}-limite{i}.pts", m.vertices[l], fmt="%.6f")
    c = m.triangles_center
    up = int(np.argmin(c.std(0)))
    ej = [k for k in range(3) if k != up]
    fig, ax = plt.subplots(1, 2, figsize=(20, 9))
    for j, sgn in enumerate((1, -1)):
        o = np.argsort(sgn * c[:, up])
        ax[j].scatter(c[o, ej[0]], c[o, ej[1]], s=0.3, c=col[o] / 255)
        ax[j].set_aspect("equal")
    for l in lazos:
        q = m.vertices[l]
        ax[0].plot(q[:, ej[0]], q[:, ej[1]], "k-", lw=0.8)
    for d in info or []:
        cen, base, punta = (np.array(d[k]) for k in ("centroide", "base", "punta"))
        ax[1].plot(*cen[ej], "k+", ms=10)
        ax[1].annotate("", punta[ej], base[ej], arrowprops={"arrowstyle": "->", "lw": 1.2})
        ax[1].text(*(cen[ej] + 1.5), str(d["id"]), fontsize=12, weight="bold")
    if pts is not None:
        ax[0].plot(pts[:, ej[0]], pts[:, ej[1]], "b-", lw=1)
    ax[0].set_title("límite gingival (negro)" + (" y .pts (azul)" if pts is not None else ""))
    ax[1].set_title("la otra cara: número en el arco, centroide (+) y eje base -> punta")
    plt.tight_layout()
    plt.savefig(out / f"{stem}-segmentado.png", dpi=70)
    plt.close(fig)


def main(argv: list[str]) -> None:
    ruta, out = pathlib.Path(argv[1]), pathlib.Path(argv[2])
    estrategia = argv[3] if len(argv) > 3 else "auto"
    m = leer(ruta)
    try:
        seg, usada, diagnostico = segmentar(m, estrategia)
    except (Desmontado, Hueco) as exc:
        print(f"{ruta.name}: {exc}")
        sys.exit(2)
    seg = numerar_por_arco(m, seg)
    lazos = limite_gingival(m, seg)
    info = dientes(m, seg)
    pts_al_lado = ruta.with_suffix(".pts")
    pts = np.loadtxt(pts_al_lado) if pts_al_lado.exists() else None
    exportar(m, seg, lazos, ruta.stem, out, pts, info)
    import json

    (out / f"{ruta.stem}-dientes.json").write_text(json.dumps(
        {"modelo": ruta.name, "estrategia": usada, "diagnostico": diagnostico, "dientes": info}, indent=1))
    largos = [float(np.linalg.norm(np.diff(m.vertices[l], axis=0), axis=1).sum()) for l in lazos]
    print(f"{ruta.name}: estrategia {usada}, {seg.max() + 1} dientes, "
          f"{int((seg == ATTACHMENT).sum())} caras de attachments, encía {int((seg == ENCIA).sum())} caras, "
          f"base {int((seg == BASE).sum())} caras")
    for k, d in diagnostico.items():
        print(f"  {k}: {d}")
    print("límite gingival:", ", ".join(f"{x:.0f} mm" for x in largos[:4]) or "no se encontró")
    for d in info:
        print(f"  diente {d['id']:2d}: {d['caras']:6d} caras, centroide {d['centroide']}, "
              f"vecinos {d['vecinos']}, attachments {d['attachments']}, tramos de límite {len(d['limite'])}")
    if pts is not None and lazos:
        from scipy.spatial import cKDTree

        d, _ = cKDTree(np.vstack([m.vertices[l] for l in lazos])).query(pts)
        print(f".pts -> límite: mediana {np.median(d):.2f} mm, p90 {np.percentile(d, 90):.2f}, máx {d.max():.2f}")


if __name__ == "__main__":
    main(sys.argv)
