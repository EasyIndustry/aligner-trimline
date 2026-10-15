"""Arma un .trimline con los puntos propuestos a partir de una segmentación de teethseg.

    python tools/proponer_puntos.py --stl X.stl --etiquetas X_labels_por_cara.npy --salida X.trimline

Lo mismo que hace la interfaz (Puntos → Segmentación), sin abrirla. Ver server/trimline/proponer.py.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from trimline import mallas, nombres, proponer  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--stl", required=True, type=Path)
    ap.add_argument("--etiquetas", required=True, type=Path, help="_labels_por_cara.npy de teethseg")
    ap.add_argument("--salida", required=True, type=Path, help="el .trimline a escribir")
    a = ap.parse_args()
    malla = mallas.desde_archivo(a.stl)
    ctrl = proponer.proponer(malla, proponer.leer_etiquetas(a.etiquetas.read_bytes()))
    dato = nombres.interpretar(a.stl.name)
    maxilar, mov = dato["maxilar"] or "sup", dato["movimiento"] or "00"
    trabajo = {
        "formato": "aligner-trimline", "version": 3, "id": dato["id"] or a.stl.stem,
        "archivos": [{"malla": hashlib.sha1(a.stl.read_bytes()).hexdigest()[:16], "nombre": a.stl.name,
                      "ruta": str(a.stl.resolve()), "maxilar": maxilar, "mov": mov, "usar": True}],
        "maxilares": {maxilar: {"offset": 0.0, "amplitud": 0.0, "ancho": 0.4, "inversas": {},
                                "controladores": [{"id": c["id"], "tipo": c["tipo"], "claves": {mov: c["pos"]}} for c in ctrl]}},
        "vista": {"maxilar": maxilar, "num": mov, "modo": None},
    }
    a.salida.write_text(json.dumps(trabajo, ensure_ascii=False, indent=1), encoding="utf-8")
    cuenta = {t: sum(c["tipo"] == t for c in ctrl) for t in "vle"}
    print(f"{a.salida}: {cuenta['v']} vestibulares, {cuenta['l']} linguales, {cuenta['e']} extremos")


if __name__ == "__main__":
    main()
