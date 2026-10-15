"""Actualizaciones desde los releases de GitHub, sin reinstalar.

Una instalación es:

    <programa>/runtime/           el Python que trae el instalador (no se toca)
    <programa>/app/               el código: esto es lo que se reemplaza
    <programa>/app.anterior/      la versión de antes, para poder volver
    <programa>/app-release.json   qué versión está puesta

Se consulta la API de GitHub sin cuenta, que tiene un límite de 60 pedidos por hora por IP (una
oficina entera sale por la misma). Si falla, por eso o por lo que sea, se usan las páginas
públicas, que no tienen ese límite: el feed releases.atom y el .tar.gz del tag.

Actualizar baja el código del release elegido a app.nueva/ y lo revisa; el cambio de carpetas
lo hace cambio.py, en un proceso aparte, cuando el servidor ya se cerró (Windows no deja
renombrar app/ mientras el programa tiene algo abierto adentro). Las librerías de Python no se
actualizan así: si un release pide una nueva, hay que bajar su instalador (se avisa antes).
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import ssl
import tarfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from html import unescape
from pathlib import Path

REPO = os.environ.get("TRIMLINE_REPO", "EasyIndustry/aligner-trimline")
NECESARIOS = ("lanzador.py", "server/trimline/app.py", "web/index.html", "requirements.txt")
FUERA = ("packaging", ".github", "tests", "tools", ".claude")       # no hacen falta para correr

APP = Path(__file__).resolve().parents[2]
PROGRAMA = APP.parent
MARCA = PROGRAMA / "app-release.json"
ANTERIOR = PROGRAMA / "app.anterior"


def instalada() -> bool:
    """True en una instalación; en un checkout de desarrollo se actualiza con git."""
    return APP.name == "app" and MARCA.exists()


def marca() -> dict:
    try:
        return json.loads(MARCA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _contexto() -> ssl.SSLContext:
    """Los certificados los valida el sistema operativo, no la lista propia de Python: en
    Windows Python no baja las raíces que faltan ni ve bien las que agrega la empresa (antivirus
    o proxy que inspecciona el tráfico), y la consulta a GitHub falla aunque el navegador ande."""
    try:
        import truststore
        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:                                  # instalaciones viejas, sin la librería
        return ssl.create_default_context()


def _pedir(url: str, timeout: float = 20) -> bytes:
    cabeceras = {"User-Agent": "aligner-trimline", "Accept": "application/vnd.github+json"}
    token = os.environ.get("TRIMLINE_GITHUB_TOKEN")        # solo hace falta si el repo pasa a privado
    if token:
        cabeceras["Authorization"] = f"Bearer {token}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=cabeceras), timeout=timeout, context=_contexto()) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise OSError(_motivo(e)) from None


def _motivo(e: urllib.error.HTTPError) -> str:
    """Qué dijo GitHub, en criollo: sobre todo el límite de pedidos sin cuenta."""
    if e.code in (403, 429) and e.headers.get("X-RateLimit-Remaining") == "0":
        vuelve = int(e.headers.get("X-RateLimit-Reset") or 0) - int(time.time())
        return f"GitHub limita las consultas sin cuenta desde esta red; se libera en {max(vuelve // 60, 1)} min"
    try:
        detalle = json.loads(e.read()).get("message") or e.reason
    except (ValueError, OSError, AttributeError):
        detalle = e.reason
    return f"GitHub respondió {e.code}: {detalle}"


def _de_la_api() -> list[dict]:
    datos = json.loads(_pedir(f"https://api.github.com/repos/{REPO}/releases?per_page=15"))
    return [{
        "tag": r["tag_name"], "titulo": r.get("name") or r["tag_name"], "notas": r.get("body") or "",
        "fecha": (r.get("published_at") or "")[:10], "prerelease": bool(r.get("prerelease")),
    } for r in datos if not r.get("draft")]


def _del_feed() -> list[dict]:
    """Los releases desde github.com/<repo>/releases.atom: sin límite, pero sin la marca de
    prerelease (se deduce del tag: v1.2.0-rc.1 es de prueba) y con las notas en HTML."""
    a = "{http://www.w3.org/2005/Atom}"
    raiz = ET.fromstring(_pedir(f"https://github.com/{REPO}/releases.atom"))
    res = []
    for e in raiz.iter(f"{a}entry"):
        enlace = e.find(f"{a}link")
        tag = (enlace.get("href") if enlace is not None else "").rsplit("/tag/", 1)[-1]
        if not tag:
            continue
        notas = re.sub(r"<[^>]+>", "", unescape(e.findtext(f"{a}content") or "")).strip()
        res.append({"tag": tag, "titulo": e.findtext(f"{a}title") or tag, "notas": notas,
                    "fecha": (e.findtext(f"{a}updated") or "")[:10], "prerelease": "-" in tag.lstrip("v")})
    return res


def releases() -> list[dict]:
    try:
        return _de_la_api()
    except Exception as api:  # noqa: BLE001
        try:
            return _del_feed()
        except Exception as feed:  # noqa: BLE001
            raise OSError(f"{api} (y la página de releases tampoco respondió: {feed})") from None


def _codigo(tag: str) -> bytes:
    """El .tar.gz del código del tag: por la API, o si no por github.com (sin límite)."""
    try:
        return _pedir(f"https://api.github.com/repos/{REPO}/tarball/{tag}", timeout=120)
    except Exception:  # noqa: BLE001
        return _pedir(f"https://github.com/{REPO}/archive/refs/tags/{tag}.tar.gz", timeout=120)


def estado(buscar: bool = False) -> dict:
    m = marca()
    res = {"instalada": instalada(), "tag": m.get("tag"), "anterior": m.get("previous_tag") if ANTERIOR.exists() else None,
           "repo": REPO, "releases": None, "error": None}
    if buscar:
        try:
            res["releases"] = releases()
        except Exception as e:  # noqa: BLE001  (sin internet no es un error del programa)
            res["error"] = f"no se pudo consultar GitHub: {e}"
    return res


def _requisitos(carpeta: Path) -> set[str]:
    try:
        lineas = (carpeta / "requirements.txt").read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    return {re.split(r"[<>=!~\[; ]", x.strip(), maxsplit=1)[0].lower() for x in lineas if x.strip() and not x.strip().startswith("#")}


def preparar(tag: str) -> tuple[Path, list[str]]:
    """Baja y revisa el código de un release. Devuelve la carpeta lista y los avisos."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", tag):
        raise ValueError(f"etiqueta inválida: {tag}")
    datos = _codigo(tag)
    nueva = PROGRAMA / "app.nueva"
    shutil.rmtree(nueva, ignore_errors=True)
    tmp = PROGRAMA / "app.bajando"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(datos), mode="r:gz") as tar:
        tar.extractall(tmp, filter="data")              # "data": sin rutas que se escapen ni enlaces raros
    raices = [p for p in tmp.iterdir() if p.is_dir()]
    if len(raices) != 1:
        raise ValueError("el release no tiene la forma esperada")
    raices[0].rename(nueva)
    shutil.rmtree(tmp, ignore_errors=True)
    faltan = [n for n in NECESARIOS if not (nueva / n).exists()]
    if faltan:
        shutil.rmtree(nueva, ignore_errors=True)
        raise ValueError(f"al release {tag} le falta: {', '.join(faltan)}")
    for n in FUERA:
        shutil.rmtree(nueva / n, ignore_errors=True)
    avisos = []
    nuevos = _requisitos(nueva) - _requisitos(APP)
    if nuevos:
        avisos.append(f"Este release usa librerías que esta instalación no trae ({', '.join(sorted(nuevos))}): bajá e instalá su instalador.")
    return nueva, avisos


def instalar(tag: str) -> dict:
    """Deja la versión lista en app.nueva/; el cambio lo hace cambio.py al reiniciar."""
    if not instalada():
        raise ValueError("esto es un checkout de desarrollo: se actualiza con git")
    nueva, avisos = preparar(tag)
    if avisos:
        shutil.rmtree(nueva, ignore_errors=True)
        raise ValueError(" ".join(avisos))
    return {"tag": tag, "modo": "instalar"}


def revertir() -> dict:
    if not instalada() or not ANTERIOR.exists():
        raise ValueError("no hay una versión anterior guardada")
    return {"tag": marca().get("previous_tag"), "modo": "revertir"}


def lanzar_cambio(modo: str, tag: str | None, datos: Path | None) -> None:
    """Arranca cambio.py desde una copia fuera de app/: espera a que este proceso suelte la
    carpeta, la cambia y vuelve a abrir el programa."""
    import subprocess
    import sys
    copia = PROGRAMA / "cambio.py"
    shutil.copyfile(Path(__file__).with_name("cambio.py"), copia)
    orden = [sys.executable, str(copia), "--programa", str(PROGRAMA), "--modo", modo]
    if tag:
        orden += ["--tag", tag]
    if datos:
        orden += ["--datos", str(datos)]
    opciones = {}
    if sys.platform == "win32":
        opciones["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        opciones["start_new_session"] = True
    subprocess.Popen(orden, cwd=str(PROGRAMA), **opciones)  # noqa: S603


def ultimo_cambio(datos: Path | None) -> dict | None:
    """Cómo salió el último cambio de versión (lo anota cambio.py), si hay."""
    try:
        return json.loads((datos / "actualizacion.json").read_text(encoding="utf-8")) if datos else None
    except (OSError, ValueError):
        return None
