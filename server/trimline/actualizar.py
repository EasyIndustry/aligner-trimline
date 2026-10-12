"""Actualizaciones desde los releases de GitHub, sin reinstalar.

Una instalación es:

    <programa>/runtime/           el Python que trae el instalador (no se toca)
    <programa>/app/               el código: esto es lo que se reemplaza
    <programa>/app.anterior/      la versión de antes, para poder volver
    <programa>/app-release.json   qué versión está puesta

Actualizar baja el código del release elegido, lo revisa y cambia app/ por el nuevo. Las
librerías de Python no se actualizan así: si un release pide una nueva, hay que bajar su
instalador (se avisa antes de instalar).
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import tarfile
import time
import urllib.request
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


def _pedir(url: str, timeout: float = 20) -> bytes:
    cabeceras = {"User-Agent": "aligner-trimline", "Accept": "application/vnd.github+json"}
    token = os.environ.get("TRIMLINE_GITHUB_TOKEN")        # solo hace falta si el repo pasa a privado
    if token:
        cabeceras["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=cabeceras), timeout=timeout) as r:
        return r.read()


def releases() -> list[dict]:
    datos = json.loads(_pedir(f"https://api.github.com/repos/{REPO}/releases?per_page=15"))
    return [{
        "tag": r["tag_name"], "titulo": r.get("name") or r["tag_name"], "notas": r.get("body") or "",
        "fecha": (r.get("published_at") or "")[:10], "prerelease": bool(r.get("prerelease")),
    } for r in datos if not r.get("draft")]


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
    datos = _pedir(f"https://api.github.com/repos/{REPO}/tarball/{tag}", timeout=120)
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


def aplicar(nueva: Path, tag: str) -> None:
    """Cambia app/ por la nueva y deja la de antes en app.anterior/."""
    previo = marca().get("tag")
    shutil.rmtree(ANTERIOR, ignore_errors=True)
    APP.rename(ANTERIOR)
    try:
        nueva.rename(APP)
    except OSError:
        ANTERIOR.rename(APP)                             # no se pudo: todo queda como estaba
        raise
    MARCA.write_text(json.dumps({"tag": tag, "applied_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                 "source": "actualizador", "previous_tag": previo}, indent=1), encoding="utf-8")


def instalar(tag: str) -> dict:
    if not instalada():
        raise ValueError("esto es un checkout de desarrollo: se actualiza con git")
    nueva, avisos = preparar(tag)
    if avisos:
        shutil.rmtree(nueva, ignore_errors=True)
        raise ValueError(" ".join(avisos))
    aplicar(nueva, tag)
    return {"tag": tag}


def revertir() -> dict:
    if not instalada() or not ANTERIOR.exists():
        raise ValueError("no hay una versión anterior guardada")
    m = marca()
    aparte = PROGRAMA / "app.cambio"
    shutil.rmtree(aparte, ignore_errors=True)
    APP.rename(aparte)
    ANTERIOR.rename(APP)
    aparte.rename(ANTERIOR)
    MARCA.write_text(json.dumps({"tag": m.get("previous_tag"), "applied_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                 "source": "vuelta atrás", "previous_tag": m.get("tag")}, indent=1), encoding="utf-8")
    return {"tag": m.get("previous_tag")}
