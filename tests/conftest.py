import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))


@pytest.fixture(scope="session")
def domo_stl() -> bytes:
    """Un modelo sintético con base plana: media esfera de radio 20 apoyada en z = 0."""
    m = trimesh.creation.icosphere(subdivisions=5, radius=20.0)
    v = m.vertices.copy()
    v[:, 2] = np.maximum(v[:, 2], 0.0)
    return trimesh.Trimesh(v, m.faces, process=False).export(file_type="stl")


def anillo(radio_v: float = 17.0, radio_l: float = 9.0, n: int = 8, num: str = "00") -> list[dict]:
    """Controladores en U sobre el domo: vestibulares por fuera, linguales por dentro, dos extremos."""
    def punto(r, a):
        return [r * np.cos(a), r * np.sin(a), float(np.sqrt(max(400 - r * r, 0)))]
    angulos = np.linspace(0.6, 2 * np.pi - 0.6, n)
    ctrl = [{"id": f"v{i}", "tipo": "v", "claves": {num: punto(radio_v, a)}} for i, a in enumerate(angulos)]
    ctrl += [{"id": f"l{i}", "tipo": "l", "claves": {num: punto(radio_l, a)}} for i, a in enumerate(angulos)]
    medio = (radio_v + radio_l) / 2
    ctrl += [{"id": "e0", "tipo": "e", "claves": {num: punto(medio, 0.3)}}, {"id": "e1", "tipo": "e", "claves": {num: punto(medio, 2 * np.pi - 0.3)}}]
    return ctrl
