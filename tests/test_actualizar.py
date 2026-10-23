from trimline import actualizar

FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>2026-10-12T19:34:46Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/v0.2.0-rc.1"/>
    <title>v0.2.0-rc.1</title>
    <content type="html">&lt;p&gt;Notas &amp;amp; cambios&lt;/p&gt;</content>
  </entry>
  <entry>
    <updated>2026-10-01T10:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/v0.1.0"/>
    <title>v0.1.0</title>
  </entry>
</feed>"""


def test_sin_la_api_usa_el_feed(monkeypatch):
    pedidos = []

    def pedir(url, timeout=20):
        pedidos.append(url)
        if "api.github.com" in url:
            raise OSError("GitHub limita las consultas sin cuenta desde esta red; se libera en 30 min")
        return FEED if url.endswith(".atom") else b"codigo"

    monkeypatch.setattr(actualizar, "_pedir", pedir)
    r = actualizar.releases()
    assert [(x["tag"], x["prerelease"], x["fecha"]) for x in r] == [("v0.2.0-rc.1", True, "2026-10-12"), ("v0.1.0", False, "2026-10-01")]
    assert r[0]["notas"] == "Notas & cambios"
    assert actualizar._codigo("v0.1.0") == b"codigo"
    assert pedidos[-1].endswith("/archive/refs/tags/v0.1.0.tar.gz")


def test_si_nada_responde_dice_por_que(monkeypatch):
    def pedir(url, timeout=20):
        raise OSError("sin red")
    monkeypatch.setattr(actualizar, "_pedir", pedir)
    e = actualizar.estado(buscar=True)
    assert e["releases"] is None and "sin red" in e["error"]


def test_valida_con_los_certificados_del_sistema(monkeypatch):
    import builtins
    import ssl

    import truststore
    assert isinstance(actualizar._contexto(), truststore.SSLContext)
    # una instalación vieja, sin truststore, sigue andando con el contexto de Python
    importar = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", lambda n, *a, **k: (_ for _ in ()).throw(ImportError(n)) if n == "truststore" else importar(n, *a, **k))
    c = actualizar._contexto()
    assert isinstance(c, ssl.SSLContext) and not isinstance(c, truststore.SSLContext)


def _programa(tmp_path, tag="v0.1.0"):
    import json
    for d, txt in (("app", "vieja"), ("app.nueva", "nueva")):
        (tmp_path / d).mkdir()
        (tmp_path / d / "version.txt").write_text(txt)
    (tmp_path / "app-release.json").write_text(json.dumps({"tag": tag}))
    return tmp_path


def test_cambio_de_version_y_vuelta(tmp_path):
    import json
    from trimline import cambio
    p = _programa(tmp_path)
    assert cambio.cambiar(p, "instalar", "v0.3.1") == "v0.3.1"
    assert (p / "app" / "version.txt").read_text() == "nueva"
    assert (p / "app.anterior" / "version.txt").read_text() == "vieja" and not (p / "app.nueva").exists()
    marca = json.loads((p / "app-release.json").read_text())
    assert (marca["tag"], marca["previous_tag"]) == ("v0.3.1", "v0.1.0")
    assert cambio.cambiar(p, "revertir", None) == "v0.1.0"
    assert (p / "app" / "version.txt").read_text() == "vieja"
    assert (p / "app.anterior" / "version.txt").read_text() == "nueva"


def test_cambio_que_no_se_puede_deja_todo_como_estaba(tmp_path, monkeypatch):
    import pytest
    from trimline import cambio
    p = _programa(tmp_path)
    monkeypatch.setattr(cambio, "ESPERA", 0.2)
    original = cambio.Path.rename

    def rename(self, destino):                     # app.nueva → app no se deja (como un antivirus)
        if self.name == "app.nueva":
            raise PermissionError(5, "Acceso denegado")
        return original(self, destino)

    monkeypatch.setattr(cambio.Path, "rename", rename)
    with pytest.raises(PermissionError):
        cambio.cambiar(p, "instalar", "v0.3.1")
    assert (p / "app" / "version.txt").read_text() == "vieja" and (p / "app.nueva").exists()


def test_reintenta_mientras_la_carpeta_esta_tomada(tmp_path, monkeypatch):
    from trimline import cambio
    p = _programa(tmp_path)
    original, intentos = cambio.Path.rename, []

    def rename(self, destino):                     # las dos primeras veces Windows dice que no
        intentos.append(self.name)
        if self.name == "app" and intentos.count("app") <= 2:
            raise PermissionError(5, "Acceso denegado")
        return original(self, destino)

    monkeypatch.setattr(cambio.Path, "rename", rename)
    monkeypatch.setattr(cambio.time, "sleep", lambda s: None)
    assert cambio.cambiar(p, "instalar", "v0.3.1") == "v0.3.1"
    assert intentos.count("app") == 3


def _wheel(nombre: str, requiere: list[str] = ()) -> bytes:
    import io
    import zipfile
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr(f"{nombre}/__init__.py", "X = 1\n")
        meta = f"Metadata-Version: 2.1\nName: {nombre}\nVersion: 1.0\n" + "".join(f"Requires-Dist: {r}\n" for r in requiere)
        z.writestr(f"{nombre}-1.0.dist-info/METADATA", meta)
    return b.getvalue()


def test_baja_las_librerias_nuevas_y_lo_que_piden(tmp_path, monkeypatch):
    """Un release que pide una librería que la instalación no trae: si es Python puro, se baja."""
    pedidos = []
    def wheel(nombre, version):
        pedidos.append((nombre, version))
        req = {"libnueva": ["libdep>=1", "otra; extra == 'docs'"]}.get(nombre, [])
        return f"{nombre}-1.0-py3-none-any.whl", "1.0", _wheel(nombre, req)
    monkeypatch.setattr(actualizar, "_wheel_puro", wheel)
    hechas = actualizar.instalar_librerias({"libnueva": "libnueva==1.0", "numpy": "numpy>=2.0"}, tmp_path)
    assert sorted(hechas) == ["libdep-1.0-py3-none-any.whl", "libnueva-1.0-py3-none-any.whl"]
    assert ("libnueva", "1.0") in pedidos and ("libdep", None) in pedidos
    assert not any(n in ("numpy", "otra") for n, _ in pedidos)       # ya está / es de un extra
    assert (tmp_path / "libnueva" / "__init__.py").exists() and (tmp_path / "libdep" / "__init__.py").exists()


def test_una_libreria_compilada_no_se_instala(tmp_path, monkeypatch):
    def wheel(nombre, version):
        raise ValueError(f"{nombre} no es Python puro: hay que bajar el instalador")
    monkeypatch.setattr(actualizar, "_wheel_puro", wheel)
    import pytest
    with pytest.raises(ValueError, match="no es Python puro"):
        actualizar.instalar_librerias({"compilada": "compilada"}, tmp_path)
    assert not list(tmp_path.iterdir())
