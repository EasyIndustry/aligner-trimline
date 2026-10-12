import numpy as np
import pytest

from conftest import anillo
from trimline import curva, mallas, nombres, proyecto
from trimline.exportar import EXPORTADORES, exportar


@pytest.fixture()
def malla(domo_stl):
    return mallas.cargar(domo_stl, "domo.stl")


def maxilar(malla, **extra):
    return {"movimientos": [{"num": n, "malla": malla.id} for n in ("00", "01", "02", "03", "04")],
            "offset": 0.0, "amplitud": 0.0, "controladores": anillo(), **extra}


def test_nombres():
    a = nombres.interpretar("0044 Reale Leandro 1.0 sup 01.stl")
    assert (a["id"], a["etapa"], a["maxilar"], a["movimiento"]) == ("0044", "1.0", "sup", "01")
    b = nombres.interpretar("00009 Caso Prueba 2.1 Inf 3 CNC2.stl")
    assert (b["maxilar"], b["movimiento"], b["sufijo"]) == ("inf", "03", "CNC2")
    d = nombres.interpretar("BN595 Apellido Nombre 2.0 BIS Sup 00 CNC3.stl")
    assert (d["id"], d["paciente"], d["etapa"], d["fase"], d["maxilar"], d["movimiento"], d["sufijo"]) == \
        ("BN595", "Apellido Nombre", "2.0", "BIS", "sup", "00", "CNC3")
    c = nombres.interpretar("28-07-2022_16-29-03_Subsetup10_Mandibular.stl")
    assert (c["maxilar"], c["movimiento"]) == ("inf", "10")
    assert nombres.interpretar("cualquiera.stl")["maxilar"] is None


def test_base_y_malla_soldada(malla):
    assert np.allclose(malla.arriba, [0, 0, 1], atol=1e-6)
    assert abs(malla.base) < 1e-6
    assert len(malla.v) < len(malla.f)                 # soldada: menos vértices que caras
    cab = np.frombuffer(malla.binario()[:8], dtype="<u4")
    assert list(cab) == [len(malla.v), len(malla.f)]
    assert len(malla.binario()) == 8 + len(malla.v) * 12 + len(malla.f) * 12


def test_mas_cercano_cae_en_la_superficie(malla):
    p = np.array([[0, 0, 30.0], [30, 0, 5], [5, 5, 50]])
    q = malla.mas_cercano(p)
    assert np.allclose(np.linalg.norm(q, axis=1), 20, atol=0.05)


def test_curva_cerrada_y_ordenada(malla):
    r = proyecto.resolver(maxilar(malla), "00", n=500)
    assert r["cerrada"] and len(r["tramos"]) == 1
    t = r["tramos"][0]
    assert t["puntos"].shape == (500, 3)
    assert np.abs(np.linalg.norm(t["puntos"], axis=1) - 20).max() < 0.05      # apoyada en la malla
    tipos = "".join(i["tipo"] if i["clase"] == "cresta" else "." for i in t["info"])
    assert tipos == "e" + ".".join("v" * 8) + "e" + ".".join("l" * 8)          # E1, vestibulares, E2, linguales
    paso = np.linalg.norm(np.diff(np.vstack([t["puntos"], t["puntos"][0]]), axis=0), axis=1)
    assert paso.max() / paso.mean() < 1.6                                       # repartida a distancia pareja


def test_el_orden_no_depende_de_los_clics(malla):
    a = maxilar(malla)
    b = maxilar(malla, controladores=list(reversed(anillo())))
    pa = proyecto.resolver(a, "00")["tramos"][0]["puntos"]
    pb = proyecto.resolver(b, "00")["tramos"][0]["puntos"]
    assert np.allclose(pa, pb, atol=1e-6)


def test_sin_extremos_queda_abierta(malla):
    m = maxilar(malla, controladores=[c for c in anillo() if c["tipo"] != "e"])
    r = proyecto.resolver(m, "00")
    assert not r["cerrada"] and len(r["tramos"]) == 2


def test_amplitud_mueve_solo_las_crestas_inversas(malla):
    plano = proyecto.resolver(maxilar(malla), "00")["tramos"][0]
    festo = proyecto.resolver(maxilar(malla, amplitud=3.0), "00")["tramos"][0]
    for info, a, b in zip(plano["info"], plano["claves"], festo["claves"]):
        if info["clase"] == "cresta":
            assert np.allclose(a, b, atol=1e-9)
        elif info["tipo"] == "v":
            assert b[2] > a[2] + 0.5                   # la cresta inversa subió hacia la corona


def test_offset_mueve_todo(malla):
    a = proyecto.resolver(maxilar(malla), "00")["tramos"][0]["claves"]
    b = proyecto.resolver(maxilar(malla, offset=2.0), "00")["tramos"][0]["claves"]
    assert (b[:, 2] > a[:, 2] + 0.3).all()


def test_keyframes_absolutos_e_interpolados(malla):
    m = maxilar(malla)
    c = m["controladores"][0]
    p0 = np.array(c["claves"]["00"])
    c["claves"]["04"] = (p0 + [0, 0, 4.0]).tolist()
    nums = ["00", "01", "02", "03", "04"]
    assert np.allclose(proyecto.posicion(c, nums, "02"), p0 + [0, 0, 2.0])     # a mitad de camino
    assert np.allclose(proyecto.posicion(c, nums, "01"), p0 + [0, 0, 1.0])
    # corregir el 00 no toca el 04: solo cambia la transición
    c["claves"]["00"] = (p0 + [0, 0, -2.0]).tolist()
    assert np.allclose(proyecto.posicion(c, nums, "04"), p0 + [0, 0, 4.0])
    assert np.allclose(proyecto.posicion(c, nums, "02"), p0 + [0, 0, 1.0])
    # después del último keyframe se queda quieto; un movimiento omitido no cuenta
    c["claves"] = {"00": p0.tolist(), "02": (p0 + [0, 0, 2.0]).tolist()}
    assert np.allclose(proyecto.posicion(c, nums, "04"), p0 + [0, 0, 2.0])
    assert np.allclose(proyecto.posicion(c, ["00", "01", "03", "04"], "04"), p0)
    assert proyecto.con_keyframe(m) == ["00", "02"]


def test_exportar_pts(malla):
    assert {"pts", "pts-por-curva"} <= set(EXPORTADORES)
    m = maxilar(malla)
    m["controladores"][0]["claves"]["02"] = m["controladores"][0]["claves"]["00"]
    movs = []
    for mov in m["movimientos"]:
        r = proyecto.resolver(m, mov["num"], n=50)
        movs.append({"num": mov["num"], "cerrada": True, "curva": r["tramos"][0]["puntos"],
                     "controladores": r["controladores"], "tiene_clave": mov["num"] in proyecto.con_keyframe(m)})
    datos = nombres.interpretar("BN595 Caso Prueba 2.0 BIS Sup 00 CNC3.stl")
    trabajo = {"id": "BN595", "datos": datos, "maxilares": {"sup": movs, "inf": movs[:2]}}
    curvas, control, caso = exportar("pts", trabajo)
    assert (curvas["nombre"], control["nombre"], caso["nombre"]) == ("BN595.pts", "BN595 PC.pts", "BN595.curva")
    lineas = curvas["texto"].split("\r\n")
    assert lineas[-1] == "" and lineas[0] == "inf 00" and lineas[51] == "inf 01"   # inferior primero, 50 puntos
    assert [x for x in lineas if x[:3] in ("inf", "sup")] == ["inf 00", "inf 01", "sup 00", "sup 01", "sup 02", "sup 03", "sup 04"]
    numeros = [n for x in lineas[1:51] for n in x.split()]
    assert all(len(x.split()) == 3 for x in lineas[1:51])
    assert all(len(n.split(".")[1]) <= 6 and not n.endswith("0") for n in numeros if "." in n)
    assert "-0 " not in curvas["texto"] and not any(n == "-0" for n in numeros)
    # puntos de control: primero, último y con keyframe
    assert [x for x in control["texto"].split("\r\n") if x[:3] in ("inf", "sup")] == ["inf 00", "inf 01", "sup 00", "sup 02", "sup 04"]
    assert caso["texto"] == '{"referencia": "CNC3", "id": "BN595", "nombre": "Caso Prueba 2.0", "etapa": "BIS"}'
    assert caso["codificacion"] == "latin-1"
    sueltos = exportar("pts-por-curva", trabajo)
    assert [f["nombre"] for f in sueltos][:3] == ["BN595_inf_00.pts", "BN595_inf_01.pts", "BN595_sup_00.pts"]
    assert len(sueltos[0]["texto"].strip().split("\r\n")) == 50


def test_numeros_como_los_del_kuka():
    from trimline.exportar.pts import _num
    assert [_num(x, 6) for x in (12.74834, -25.4985574, -1.0, -0.0000001, 0.000743)] == ["12.74834", "-25.498557", "-1", "0", "0.000743"]


def test_orden_de_los_puntos_de_control():
    from trimline.exportar.pts import _orden_maquina
    c = lambda i, t, x: {"id": i, "tipo": t, "pos": [x, 0, 0]}
    arcada = [c("e1", "e", 20), c("v1", "v", 15), c("v2", "v", -15), c("e2", "e", -20), c("l1", "l", -10), c("l2", "l", 10)]
    assert [k["id"] for k in _orden_maquina(arcada)] == ["e2", "v2", "v1", "e1", "l1", "l2"]


def test_curva_arranca_adelante_hacia_mas_x(malla):
    t = proyecto.resolver(maxilar(malla), "00", n=200)["tramos"][0]
    p = curva.desde_el_frente(t["puntos"], t["claves"], t["info"])
    assert len(p) == 200
    assert abs(p[0, 0]) < 1e-6 and p[1, 0] > p[0, 0]
    # adelante es del lado vestibular: más lejos del centro que los linguales
    assert np.hypot(p[0, 0], p[0, 1]) > 13


def test_bezier_tangentes_planas_y_ancho(malla):
    m = maxilar(malla, amplitud=2.0)
    t = proyecto.resolver(m, "00")["tramos"][0]
    for k, hs in zip(t["claves"], t["manijas"]):
        assert abs((hs[0] - k) @ malla.arriba) < 1e-9 and abs((hs[1] - k) @ malla.arriba) < 1e-9   # planas
    largo = lambda tr, clase: np.mean([np.linalg.norm(h[1] - k) for i, k, h in zip(tr["info"], tr["claves"], tr["manijas"]) if i["clase"] == clase and i["tipo"] == "v"])
    ancha = proyecto.resolver({**m, "ancho": 0.6}, "00")["tramos"][0]
    assert largo(ancha, "cresta") > largo(t, "cresta") and largo(ancha, "inversa") < largo(t, "inversa")
    assert not np.allclose(ancha["puntos"], t["puntos"], atol=1e-3)


def test_manija_puesta_a_mano(malla):
    m = maxilar(malla, amplitud=2.0)
    antes = proyecto.resolver(m, "00")["tramos"][0]
    m["controladores"][3]["manijas"] = {"b": [0.0, 0.0, 3.0]}
    r = proyecto.resolver(m, "00")["tramos"][0]
    i = next(k for k, info in enumerate(r["info"]) if info.get("id") == "v3")
    assert np.allclose(r["manijas"][i, 1] - r["claves"][i], [0, 0, 3.0])       # la puesta a mano
    assert np.allclose(r["manijas"][i, 0], antes["manijas"][i, 0])             # la otra sigue calculada
    assert not np.allclose(r["puntos"], antes["puntos"], atol=1e-3)


def test_dientes_sin_festoneado_ni_offset(malla):
    plano = proyecto.resolver(maxilar(malla), "00")["tramos"][0]
    m = maxilar(malla, amplitud=3.0, offset=1.5)
    for c in m["controladores"]:
        if c["id"] in ("v2", "v3", "v4"):
            c["festoneado"] = False
    r = proyecto.resolver(m, "00")["tramos"][0]
    claves = {(info.get("id") or info["clave"]): p for info, p in zip(r["info"], r["claves"])}
    base = {(info.get("id") or info["clave"]): p for info, p in zip(plano["info"], plano["claves"])}
    # entre dos dientes sin festoneado la cresta inversa queda recta: solo el offset la mueve
    recta, festo = claves["v2|v3"][2] - base["v2|v3"][2], claves["v5|v6"][2] - base["v5|v6"][2]
    assert recta > 0.3 and festo > recta + 1.0
    # sin offset, la cresta no se mueve aunque el resto sí
    m["controladores"][3]["offset"] = False
    r = proyecto.resolver(m, "00")["tramos"][0]
    i = next(k for k, info in enumerate(r["info"]) if info.get("id") == "v3")
    j = next(k for k, info in enumerate(plano["info"]) if info.get("id") == "v3")
    assert np.allclose(r["claves"][i], plano["claves"][j], atol=1e-6)


def test_cresta_inversa_corrida_a_mano_sigue_al_feston(malla):
    m = maxilar(malla, inversas={"v3|v4": [0.0, 0.0, 2.0]})
    r = proyecto.resolver(m, "00")["tramos"][0]
    antes = proyecto.resolver(maxilar(malla), "00")["tramos"][0]
    i = next(k for k, info in enumerate(r["info"]) if info.get("clave") == "v3|v4")
    assert r["claves"][i][2] > antes["claves"][i][2] + 1.0
    # mover los dientes vecinos la arrastra: el ajuste es relativo, no una posición fija
    for c in m["controladores"]:
        if c["id"] in ("v3", "v4"):
            c["claves"]["04"] = (np.array(c["claves"]["00"]) + [0, 0, -2.0]).tolist()
    r4 = proyecto.resolver(m, "04")["tramos"][0]
    assert r4["claves"][i][2] < r["claves"][i][2] - 1.0


def test_manija_de_un_extremo(malla):
    m = maxilar(malla)
    antes = proyecto.resolver(m, "00")["tramos"][0]
    m["controladores"][-1]["manijas"] = {"a": [0.0, 0.0, 2.5]}
    r = proyecto.resolver(m, "00")["tramos"][0]
    i = next(k for k, info in enumerate(r["info"]) if info.get("id") == m["controladores"][-1]["id"])
    assert np.allclose(r["manijas"][i, 0] - r["claves"][i], [0, 0, 2.5])
    assert not np.allclose(r["puntos"], antes["puntos"], atol=1e-3)
