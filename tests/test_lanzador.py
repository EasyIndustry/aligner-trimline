import importlib.util
import json
import socket
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("lanzador", RAIZ / "lanzador.py")
lanzador = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lanzador)


def test_puerto_libre_desde_el_8000(tmp_path, monkeypatch):
    monkeypatch.delenv("TRIMLINE_PORT", raising=False)
    p = lanzador.elegir_puerto(tmp_path)
    assert lanzador.DESDE <= p < lanzador.HASTA and lanzador.libre(p)
    # ocupado ese, elige otro
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # el puerto puede estar recién soltado
        s.bind(("127.0.0.1", p))
        s.listen()
        assert not lanzador.libre(p)
        assert lanzador.elegir_puerto(tmp_path) != p


def test_reinicio_vuelve_al_puerto_anotado(tmp_path, monkeypatch):
    monkeypatch.delenv("TRIMLINE_PORT", raising=False)
    with socket.socket() as s:                      # uno libre que no sea el primero
        s.bind(("127.0.0.1", 0))
        anotado = s.getsockname()[1]
    (tmp_path / "servidor.json").write_text(json.dumps({"puerto": anotado}))
    assert lanzador.anotado(tmp_path) == anotado
    assert lanzador.elegir_puerto(tmp_path, reinicio=True) == anotado
    (tmp_path / "servidor.json").write_text("roto")
    assert lanzador.anotado(tmp_path) is None


def test_puerto_forzado(tmp_path, monkeypatch):
    monkeypatch.setenv("TRIMLINE_PORT", "8123")
    assert lanzador.elegir_puerto(tmp_path) == 8123


def test_bandeja_no_rompe_fuera_de_windows(monkeypatch):
    from trimline import bandeja
    monkeypatch.delenv("TRIMLINE_BANDEJA", raising=False)
    monkeypatch.setattr(bandeja.sys, "platform", "linux")
    sacar = bandeja.iniciar("http://127.0.0.1:8000/", RAIZ / "web" / "icono.ico", lambda: None)
    sacar()


def test_icono_para_el_instalador():
    Image = pytest.importorskip("PIL.Image")             # Pillow solo va en Windows
    ico = Image.open(RAIZ / "web" / "icono.ico")
    assert (256, 256) in ico.info["sizes"] and (16, 16) in ico.info["sizes"]


def test_sabe_que_version_esta_instalada():
    import re
    texto = (RAIZ / "server" / "trimline" / "__init__.py").read_text()
    assert lanzador.version_instalada() == re.search(r'__version__ = "([^"]+)"', texto)[1]
    assert lanzador.version_en(1) is None           # en el puerto 1 no hay nadie
