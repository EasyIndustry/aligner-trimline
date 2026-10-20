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
    assert [f["nombre"] for f in exp] == ["0044.pts", "0044 PC.pts", "0044.curva"]
    assert exp[0]["texto"].count("\r\n") == 2 * 501
    assert exp[1]["texto"].startswith("sup 01\r\n") and "sup 02" in exp[1]["texto"]       # el primero y el último
    # el .json viaja en bytes Latin-1, con los datos del nombre del STL
    import base64, json
    assert json.loads(base64.b64decode(exp[2]["datos"]).decode("latin-1")) == {
        "referencia": "", "id": "0044", "nombre": "Caso Prueba 1.0", "etapa": ""}


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


def test_guardar_y_abrir_curva(domo_stl, tmp_path):
    from trimline import mallas
    (tmp_path / "0044 Caso Prueba 1.0 sup 01.stl").write_bytes(domo_stl)
    (tmp_path / "notas.txt").write_text("no es un modelo")
    c = cliente.post("/api/mallas/carpeta", json={"carpeta": str(tmp_path)}).json()
    assert [m["nombre"] for m in c["mallas"]] == ["0044 Caso Prueba 1.0 sup 01.stl"] and not c["errores"]
    m = c["mallas"][0]
    assert m["archivo"]["maxilar"] == "sup" and m["ruta"].endswith("sup 01.stl")
    trabajo = {"id": "0044", "archivos": [{"malla": m["id"], "nombre": m["nombre"], "maxilar": "sup", "mov": "01", "usar": True}],
               "maxilares": {"sup": {"offset": 0.5, "controladores": anillo(num="01"), "inversas": {"v1|v2": [0, 0, 1]}}}}
    r = cliente.post("/api/trabajo/guardar", json=trabajo)
    assert r.status_code == 200 and r.headers["X-Sin-Ruta"] == "0"
    assert len(r.content) < 5000                      # sin mallas adentro: solo la ruta
    assert r.json()["archivos"][0]["ruta"] == m["ruta"]
    antes = mallas.obtener(m["id"])
    mallas.descartar(m["id"])                         # como si el programa se hubiera cerrado
    a = cliente.post("/api/trabajo/abrir", content=r.content).json()
    assert a["trabajo"]["maxilares"]["sup"]["inversas"] == {"v1|v2": [0, 0, 1]}
    assert a["mallas"][0]["id"] == m["id"] and not a["faltan"]
    despues = mallas.obtener(m["id"])
    assert np.array_equal(antes.v, despues.v) and np.array_equal(antes.f, despues.f)

    mallas.descartar(m["id"])                         # y si el STL ya no está, avisa cuál falta
    (tmp_path / m["nombre"]).unlink()
    a = cliente.post("/api/trabajo/abrir", content=r.content).json()
    assert a["trabajo"]["archivos"] == [] and a["faltan"][0]["nombre"] == m["nombre"]
    assert cliente.post("/api/trabajo/abrir", content=b"cualquier cosa").status_code == 422


def test_guardar_sin_ruta_y_abrir_los_viejos(domo_stl):
    import io
    import json
    import zipfile
    from trimline import mallas
    m = cliente.post("/api/mallas", params={"nombre": "0045 Otro Caso 1.0 inf 00.stl"}, content=domo_stl).json()
    mallas.obtener(m["id"]).ruta = None               # como si se hubiera arrastrado al navegador
    r = cliente.post("/api/trabajo/guardar", json={"id": "0045", "archivos": [{"malla": m["id"], "nombre": "x.stl"}]})
    assert r.headers["X-Sin-Ruta"] == "1" and "ruta" not in r.json()["archivos"][0]
    # los .trimline de la versión 2 traían las mallas en un zip
    viejo = mallas.obtener(m["id"])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("trabajo.json", json.dumps({"formato": "aligner-trimline", "version": 2, "archivos": [{"malla": m["id"], "nombre": "x.stl"}]}))
        z.writestr("mallas.json", json.dumps({m["id"]: {"nombre": "x.stl", "arriba": list(viejo.arriba), "base": viejo.base}}))
        z.writestr(f"mallas/{m['id']}.bin", viejo.binario())
    mallas.descartar(m["id"])
    a = cliente.post("/api/trabajo/abrir", content=buf.getvalue()).json()
    assert a["mallas"][0]["id"] == m["id"] and a["faltan"] == []


def test_exportar_a_una_carpeta(domo_stl, tmp_path):
    m = cliente.post("/api/mallas", params={"nombre": "BN595 Caso Prueba 2.0 BIS Sup 01 CNC3.stl"}, content=domo_stl).json()
    maxilar = {"movimientos": [{"num": "01", "malla": m["id"]}], "controladores": anillo(num="01")}
    pedido = {"id": "BN595", "maxilares": {"sup": maxilar}, "carpeta": str(tmp_path)}
    r = cliente.post("/api/exportar", json=pedido)
    assert r.status_code == 200, r.text
    assert sorted(p.name for p in tmp_path.iterdir()) == ["BN595 PC.pts", "BN595.curva", "BN595.pts"]
    assert (tmp_path / "BN595.pts").read_bytes().startswith(b"sup 01\r\n")
    assert (tmp_path / "BN595.curva").read_bytes().decode("latin-1").startswith('{"referencia": ')
    # una segunda vez no pisa sin permiso
    (tmp_path / "BN595.pts").write_text("viejo")
    r = cliente.post("/api/exportar", json=pedido)
    assert r.status_code == 409 and "BN595.pts" in r.json()["detail"]
    assert (tmp_path / "BN595.pts").read_text() == "viejo"
    assert cliente.post("/api/exportar", json={**pedido, "pisar": True}).status_code == 200
    assert (tmp_path / "BN595.pts").read_text() != "viejo"
    assert cliente.post("/api/exportar", json={**pedido, "carpeta": str(tmp_path / "no-existe")}).status_code == 422


def test_modelos_arrastrados_se_encuentran_junto_al_trimline(domo_stl, tmp_path):
    from trimline import mallas
    nombre = "0046 Caso Prueba 1.0 sup 03.stl"
    m = cliente.post("/api/mallas", params={"nombre": nombre}, content=domo_stl).json()
    mallas.obtener(m["id"]).ruta = None               # arrastrado: el navegador no da la ruta
    (tmp_path / nombre).write_bytes(domo_stl)          # pero el STL está en la carpeta del trabajo
    trabajo = {"id": "0046", "archivos": [{"malla": m["id"], "nombre": nombre, "maxilar": "sup", "mov": "03", "usar": True}],
               "maxilares": {"sup": {"controladores": anillo(num="03")}}}
    destino = tmp_path / "0046.trimline"
    r = cliente.post("/api/trabajo/guardar-en", json={"trabajo": trabajo, "ruta": str(destino)}).json()
    assert r["ruta"] == str(destino) and r["sin_ruta"] == []
    assert r["rutas"] == {m["id"]: str((tmp_path / nombre).resolve())}
    import json
    assert json.loads(destino.read_text())["archivos"][0]["ruta"] == str((tmp_path / nombre).resolve())

    # un .trimline sin rutas (guardado desde el navegador) también encuentra los STL de su carpeta
    sin = json.loads(destino.read_text())
    del sin["archivos"][0]["ruta"]
    destino.write_text(json.dumps(sin))
    mallas.descartar(m["id"])
    a = cliente.post("/api/trabajo/abrir-de", json={"ruta": str(destino)}).json()
    assert a["faltan"] == [] and a["mallas"][0]["id"] == m["id"] and a["mallas"][0]["ruta"].endswith(nombre)


def test_curva_de_referencia():
    suelta = "0 20.9 -9.5\r\n0.83 20.88 -9.62\r\n1.6 20.85 -9.3\r\n"
    r = cliente.post("/api/referencia", params={"nombre": "BY179_inf_00.pts"}, content=suelta).json()
    assert r["curvas"] == [{"maxilar": "inf", "mov": "00", "puntos": [0, 20.9, -9.5, 0.83, 20.88, -9.62, 1.6, 20.85, -9.3]}]
    bloques = "inf 00\r\n1 2 3\r\n4 5 6\r\nsup 07\r\n7 8 9\r\n1 1 1\r\n"
    r = cliente.post("/api/referencia", params={"nombre": "X.pts"}, content=bloques).json()
    assert [(c["maxilar"], c["mov"], len(c["puntos"])) for c in r["curvas"]] == [("inf", "00", 6), ("sup", "07", 6)]
    r = cliente.post("/api/referencia", params={"nombre": "cualquiera.pts"}, content=suelta).json()
    assert r["curvas"][0]["maxilar"] is None                 # sin nombre que lo diga: el que se mira
    assert cliente.post("/api/referencia", params={"nombre": "x.pts"}, content="hola").status_code == 422


def test_proyecto_nuevo_no_pisa_y_suelta_las_mallas(domo_stl, tmp_path):
    from trimline import mallas
    m = cliente.post("/api/mallas", params={"nombre": "0047 Caso Prueba 1.0 sup 00.stl"}, content=domo_stl).json()
    otra = cliente.post("/api/mallas", params={"nombre": "x.stl"}, content=b"otra" + domo_stl[4:]).json()  # otro encabezado: otra malla
    trabajo = {"id": "0047", "archivos": [{"malla": m["id"], "nombre": "0047 Caso Prueba 1.0 sup 00.stl", "maxilar": "sup", "mov": "00", "usar": True}]}
    destino = tmp_path / "0047.trimline"
    assert cliente.post("/api/trabajo/guardar-en", json={"trabajo": trabajo, "ruta": str(destino), "no_pisar": True}).status_code == 200
    antes = destino.read_bytes()
    r = cliente.post("/api/trabajo/guardar-en", json={"trabajo": {**trabajo, "id": "otro"}, "ruta": str(destino), "no_pisar": True})
    assert r.status_code == 409 and destino.read_bytes() == antes
    # Guardar (sin no_pisar) sí reescribe
    assert cliente.post("/api/trabajo/guardar-en", json={"trabajo": trabajo, "ruta": str(destino)}).status_code == 200

    assert cliente.post("/api/mallas/olvidar", json={"conservar": [m["id"]]}).json()["olvidadas"] >= 1
    assert mallas.obtener(m["id"]) and cliente.get(f"/api/mallas/{otra['id']}/bin").status_code == 404


def test_listar_los_modelos_de_una_carpeta(domo_stl, tmp_path):
    (tmp_path / "b.stl").write_bytes(domo_stl)
    (tmp_path / "a.STL").write_bytes(domo_stl)
    (tmp_path / "notas.txt").write_text("x")
    r = cliente.post("/api/mallas/carpeta", json={"carpeta": str(tmp_path), "listar": True}).json()
    assert r["nombres"] == ["a.STL", "b.stl"]
    uno = cliente.post("/api/mallas/carpeta", json={"carpeta": str(tmp_path), "nombres": ["b.stl"]}).json()
    assert [m["nombre"] for m in uno["mallas"]] == ["b.stl"] and uno["mallas"][0]["ruta"] == str((tmp_path / "b.stl").resolve())


def test_respaldo_sin_carpeta_va_a_los_datos(domo_stl, tmp_path, monkeypatch):
    monkeypatch.setenv("TRIMLINE_HOME", str(tmp_path))
    m = cliente.post("/api/mallas", params={"nombre": "0048 Caso Prueba 1.0 sup 00.stl"}, content=domo_stl).json()
    trabajo = {"id": "0048", "archivos": [{"malla": m["id"], "nombre": "0048 Caso Prueba 1.0 sup 00.stl", "maxilar": "sup", "mov": "00", "usar": True}]}
    r = cliente.post("/api/trabajo/guardar-en", json={"trabajo": trabajo, "respaldo": True, "nombre": "../0048.trimline.bak"}).json()
    assert r["ruta"] == str(tmp_path / "respaldos" / "0048.trimline.bak") and Path(r["ruta"]).is_file()
