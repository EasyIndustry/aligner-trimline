"""Dibuja el ícono del programa: un diente con su línea de recorte festoneada.

    python tools/icono.py

Deja web/icono.ico (varios tamaños: instalador, accesos directos, bandeja y pestaña) y
web/icono.png (256 px). Necesita Pillow; el resultado se commitea, así el instalador no lo dibuja.
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parents[1]
L = 1024                                    # se dibuja grande y se achica: bordes suaves
FONDO, DIENTE, SOMBRA, CURVA = "#2f3a4a", "#f2efe9", "#cfc9bf", "#ff3b4e"


def bezier(p0, p1, p2, p3, n=24):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
                  for a, b, c, d in zip(p0, p1, p2, p3)) for t in (i / n for i in range(n + 1))]


def diente() -> list[tuple[float, float]]:
    """El contorno de un molar: corona con dos cúspides y dos raíces, en sentido horario."""
    s = L / 1024
    tramos = [
        ((250, 420), (240, 250), (330, 200), (400, 225)),     # cúspide izquierda
        ((400, 225), (450, 245), (480, 265), (512, 262)),
        ((512, 262), (544, 265), (574, 245), (624, 225)),
        ((624, 225), (694, 200), (784, 250), (774, 420)),     # cúspide derecha
        ((774, 420), (768, 520), (720, 560), (700, 620)),     # cuello derecho
        ((700, 620), (680, 720), (690, 820), (640, 850)),     # raíz derecha
        ((640, 850), (600, 870), (580, 780), (560, 700)),
        ((560, 700), (545, 650), (530, 630), (512, 630)),     # furca
        ((512, 630), (494, 630), (479, 650), (464, 700)),
        ((464, 700), (444, 780), (424, 870), (384, 850)),     # raíz izquierda
        ((384, 850), (334, 820), (344, 720), (324, 620)),
        ((324, 620), (304, 560), (256, 520), (250, 420)),     # cuello izquierdo
    ]
    puntos = []
    for t in tramos:
        puntos += bezier(*t)[:-1]
    return [(x * s, y * s) for x, y in puntos]


def festoneado() -> list[tuple[float, float]]:
    """La línea de recorte: festones que bajan en el medio del diente y suben entre dientes."""
    puntos = []
    for i in range(801):
        x = 90 + (L - 180) * i / 800
        u = (x - 512) / 420                                   # -1 … 1 de lado a lado
        y = 560 + 70 * math.cos(u * math.pi * 1.5) - 40 * u * u
        puntos.append((x * L / 1024, y * L / 1024))
    return puntos


def dibujar() -> Image.Image:
    im = Image.new("RGBA", (L, L), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((24, 24, L - 24, L - 24), radius=200, fill=FONDO)
    contorno = diente()
    d.polygon([(x + 14, y + 18) for x, y in contorno], fill="#1f2733")          # sombra apoyada
    d.polygon(contorno, fill=DIENTE)
    d.polygon([(x, y) for x, y in contorno if y > 640], fill=SOMBRA)              # raíces un tono abajo
    for x, y in festoneado():                                # un trazo de círculos: grueso y sin dientes
        d.ellipse((x - 23, y - 23, x + 23, y + 23), fill=CURVA)
    return im


def main() -> None:
    im = dibujar()
    im.resize((256, 256), Image.LANCZOS).save(RAIZ / "web" / "icono.png")
    im.save(RAIZ / "web" / "icono.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("web/icono.ico y web/icono.png")


if __name__ == "__main__":
    main()
