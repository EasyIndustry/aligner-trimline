import hashlib
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from conftest import anillo
from trimline.app import app

cliente = TestClient(app)
RAIZ = Path(__file__).resolve().parents[1]


def test_flujo_completo(domo_stl):
    assert cliente.get("/api/version").json()["nombre"] == "aligner-trimline"
    r = cliente.post("/api/mallas", params={"nombre": "0044 Caso Prueba 1.0 sup 01.stl"}, content=domo_stl)
    assert r.status_code == 200
    m = r.json()
    assert m["archivo"]["maxilar"] == "sup" and m["archivo"]["movimiento"] == "01"

    b = cliente.get(f"/api/mallas/{m['id']}/bin").content
    nv, nf = np.frombuffer(b[:8], dtype="<u4")
    assert (nv, nf) == (m["vertices"], m["caras"])
    assert np.frombuffer(b, dtype="<u4", offset=8 + int(nv) * 12).max() == nv - 1

    maxilar = {"movimientos": [{"num": "01", "malla": m["id"]}, {"num": "02", "malla": m["id"]}],
               "offset": 0.5, "amplitud": 1.0, "controladores": anillo(num="01")}
    res = cliente.post("/api/resolver", json={"maxilar": maxilar, "n": 120}).json()["movimientos"]
    assert set(res) == {"01", "02"} and res["01"]["cerrada"]
    assert len(res["01"]["tramos"][0]["puntos"]) == 360
    assert all(c["clave"] for c in res["01"]["controladores"]) and not any(c["clave"] for c in res["02"]["controladores"])

    exp = cliente.post("/api/exportar", json={"id": "0044", "formato": "pts", "n": 500, "maxilares": {"sup": maxilar}}).json()["archivos"]
    assert [f["nombre"] for f in exp] == ["0044.pts", "0044_PC.pts"]
    assert exp[0]["texto"].count("\r\n") == 2 * 501
    assert exp[1]["texto"].startswith("sup 01\r\n") and "sup 02" not in exp[1]["texto"]


def test_errores_claros(domo_stl):
    assert cliente.post("/api/mallas", params={"nombre": "roto.stl"}, content=b"esto no es una malla").status_code == 422
    assert cliente.get("/api/mallas/noexiste/bin").status_code == 404
    m = cliente.post("/api/mallas", params={"nombre": "a.stl"}, content=domo_stl).json()
    abierta = {"movimientos": [{"num": "00", "malla": m["id"]}], "controladores": [c for c in anillo() if c["tipo"] != "e"]}
    r = cliente.post("/api/exportar", json={"id": "x", "maxilares": {"sup": abierta}})
    assert r.status_code == 422 and "no está cerrada" in r.json()["detail"]
    assert cliente.post("/api/exportar", json={"id": "x", "maxilares": {}}).status_code == 422


def test_interfaz_y_actualizador():
    assert "Línea de recorte" in cliente.get("/index.html").text
    a = cliente.get("/api/actualizacion").json()
    assert a["instalada"] is False                      # un checkout se actualiza con git
    assert cliente.post("/api/actualizacion/instalar", json={"tag": "v9.9.9"}).status_code == 422


def test_los_motores_vendorizados_no_se_editaron():
    for motor in ("threejs-render-engine", "threejs-cad-sdk", "threejs-material-engine"):
        carpeta = RAIZ / "web" / "vendor" / motor
        version = (carpeta / "VERSION").read_text().split()
        assert len(version) == 3 and len(version[2]) == 40
        lineas = (carpeta / "MANIFEST").read_text().splitlines()
        assert lineas
        for linea in lineas:
            sha, ruta = linea.split(maxsplit=1)
            assert hashlib.sha256((carpeta / ruta.strip()).read_bytes()).hexdigest() == sha, f"{motor}/{ruta} fue modificado"
