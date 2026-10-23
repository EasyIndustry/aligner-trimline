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
renombrar app/ mientras el programa tiene algo abierto adentro). Si un release pide una librería
de Python que esta instalación no tiene y es Python puro (un wheel py3-none-any, como networkx),
se baja de PyPI al runtime antes del cambio; una con partes compiladas no: hay que bajar el
instalador de ese release (se avisa antes).
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import ssl
import sys
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


def _requisitos(carpeta: Path) -> dict[str, str]:
    """{nombre: línea} de requirements.txt (sin las de otro sistema, como pystray en Linux)."""
    try:
        lineas = (carpeta / "requirements.txt").read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    out = {}
    for x in lineas:
        x = x.split("#", 1)[0].strip()
        if not x:
            continue
        nombre = re.split(r"[<>=!~\[; ]", x, maxsplit=1)[0].lower()
        marca = x.split(";", 1)[1].strip() if ";" in x else ""
        m = re.fullmatch(r"sys_platform\s*==\s*['\"]([^'\"]+)['\"]", marca)
        if marca and m and m.group(1) != sys.platform:
            continue
        out[nombre] = x
    return out


def _instalada_lib(nombre: str) -> bool:
    from importlib import metadata
    try:
        metadata.version(nombre)
        return True
    except metadata.PackageNotFoundError:
        return False


def _version_pedida(linea: str) -> str | None:
    m = re.search(r"==\s*([A-Za-z0-9._-]+)", linea)
    return m.group(1) if m else None


def _wheel_puro(nombre: str, version: str | None) -> tuple[str, str, bytes]:
    """(nombre del archivo, versión, contenido) del wheel py3-none-any de PyPI."""
    ruta = f"{nombre}/{version}" if version else nombre
    info = json.loads(_pedir(f"https://pypi.org/pypi/{ruta}/json"))
    version = info["info"]["version"]
    for u in info.get("urls", []):
        if u.get("packagetype") == "bdist_wheel" and u["filename"].endswith("-py3-none-any.whl"):
            return u["filename"], version, _pedir(u["url"], timeout=120)
    raise ValueError(f"{nombre} {version} no es Python puro: hay que bajar el instalador")


def instalar_librerias(lineas: dict[str, str], destino: Path | None = None) -> list[str]:
    """Baja de PyPI y descomprime en el runtime las librerías que faltan (y lo que ellas pidan).

    Solo wheels de Python puro; si alguna no lo es, no se instala nada. Devuelve lo instalado.
    """
    import sysconfig
    import zipfile
    from email.parser import Parser

    destino = destino or Path(sysconfig.get_paths()["purelib"])
    pendientes = [(n, l) for n, l in lineas.items() if not _instalada_lib(n)]
    bajados, vistos = [], set()
    while pendientes:
        nombre, linea = pendientes.pop()
        if nombre in vistos:
            continue
        vistos.add(nombre)
        archivo, version, datos = _wheel_puro(nombre, _version_pedida(linea))
        with zipfile.ZipFile(io.BytesIO(datos)) as z:
            meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
            for req in Parser().parsestr(z.read(meta).decode("utf-8")).get_all("Requires-Dist") or []:
                if ";" in req:                                   # extras u otro sistema: no hacen falta
                    continue
                dep = re.split(r"[<>=!~\[ (]", req.strip(), maxsplit=1)[0].lower()
                if dep and not _instalada_lib(dep):
                    pendientes.append((dep, req))
        bajados.append((archivo, datos))
    hechas = []
    for archivo, datos in bajados:
        with zipfile.ZipFile(io.BytesIO(datos)) as z:
            for n in z.namelist():
                if n.startswith(("/", "\\")) or ".." in Path(n).parts:
                    raise ValueError(f"{archivo}: ruta rara adentro ({n})")
            z.extractall(destino)
        hechas.append(archivo)
    return hechas


def preparar(tag: str) -> tuple[Path, dict[str, str]]:
    """Baja y revisa el código de un release. Devuelve la carpeta lista y las librerías que pide
    y esta instalación no tiene ({nombre: línea de requirements.txt})."""
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
    nuevas = {n: l for n, l in _requisitos(nueva).items() if not _instalada_lib(n)}
    return nueva, nuevas


def instalar(tag: str) -> dict:
    """Deja la versión lista en app.nueva/ (y sus librerías nuevas, si son Python puro); el
    cambio lo hace cambio.py al reiniciar."""
    if not instalada():
        raise ValueError("esto es un checkout de desarrollo: se actualiza con git")
    nueva, nuevas = preparar(tag)
    if nuevas:
        try:
            instalar_librerias(nuevas)
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(nueva, ignore_errors=True)
            raise ValueError(f"Este release usa librerías que esta instalación no trae ({', '.join(sorted(nuevas))}) "
                             f"y no se pudieron bajar ({e}): bajá e instalá su instalador.") from None
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
