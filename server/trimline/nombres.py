"""Qué maxilar y qué movimiento es cada archivo, a partir de su nombre.

Es una propuesta: la pantalla de carga deja corregir lo que no se reconoce.
"""
from __future__ import annotations

import re

# 0044 Apellido Nombre 1.0 sup 01.stl  ·  00009 Apellido Nombre 2.1 Inf 03 CNC2.stl
# BN595 Apellido Nombre 2.0 BIS Sup 00 CNC3.stl  (con fase: BIS)
_CASO = re.compile(
    r"^(?P<id>\S+)\s+(?P<paciente>.+?)\s+(?P<etapa>\d+\.\d+)(?:\s+(?P<fase>[A-Za-z]+))?\s+(?P<maxilar>sup|inf)\s+(?P<mov>\d+)(?:\s+(?P<sufijo>.+))?$",
    re.IGNORECASE,
)
_SUP = re.compile(r"(maxillary|maxilar[ _-]?sup|superior|upper|\bsup\b|\bmax\b)", re.IGNORECASE)
_INF = re.compile(r"(mandibular|inferior|lower|\binf\b|\bman\b)", re.IGNORECASE)
_MOV = re.compile(r"(?:subsetup|step|stage|mov(?:imiento)?)[ _-]?(\d+)", re.IGNORECASE)


def interpretar(nombre: str) -> dict:
    """{id, paciente, etapa, fase, maxilar: 'sup'|'inf'|None, movimiento: '01'|None, sufijo}."""
    base = re.sub(r"\.[A-Za-z0-9]+$", "", nombre.replace("\\", "/").rsplit("/", 1)[-1])
    m = _CASO.match(base)
    if m:
        return {
            "id": m["id"], "paciente": m["paciente"], "etapa": m["etapa"], "fase": m["fase"] or "",
            "maxilar": m["maxilar"].lower(), "movimiento": m["mov"].zfill(2), "sufijo": m["sufijo"] or "",
        }
    plano = base.replace("_", " ")
    maxilar = "sup" if _SUP.search(plano) else "inf" if _INF.search(plano) else None
    mov = _MOV.search(base)
    return {
        "id": "", "paciente": "", "etapa": "", "fase": "",
        "maxilar": maxilar, "movimiento": mov.group(1).zfill(2) if mov else None, "sufijo": "",
    }
