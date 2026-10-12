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
