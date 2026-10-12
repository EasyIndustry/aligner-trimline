#!/usr/bin/env bash
# Arma el instalador de Windows desde Linux, sin Windows ni Wine.
#
#   packaging/build_win.sh <version>          # ej. packaging/build_win.sh 0.1.0
#
# Deja packaging/build/AlignerTrimlineSetup-<version>.exe. Lo que se instala es:
#
#   runtime/            CPython portable (python-build-standalone) con las librerías adentro
#   app/                el código de este repo tal cual (lo que después cambia el actualizador)
#   app-release.json    qué versión es
#
# Va un Python entero en vez de un .exe congelado para que el actualizador pueda cambiar app/
# por código .py suelto sin tocar el runtime.
set -euo pipefail

VERSION="${1:?uso: packaging/build_win.sh <version>}"
VERSION="${VERSION#v}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$RAIZ/packaging/build"
CARGA="$BUILD/carga"
PY_VERSION="3.12"
MAKENSIS="${MAKENSIS:-makensis}"
PYTHON="${PYTHON:-python3}"            # el Python del que arma: necesita pip y packaging

# Las versiones exactas que viajan en el instalador. requirements.txt dice qué hace falta;
# acá se fija con cuál se prueba.
PAQUETES=(
  "fastapi==0.143.0" "uvicorn==0.54.0" "numpy==2.5.4" "scipy==1.18.1" "trimesh==5.1.1"
  "pystray==0.19.5" "pillow==12.3.0"
)

rm -rf "$BUILD"
mkdir -p "$CARGA"

echo "== intérprete"
API="https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
AUTH=()
[[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
URL="$(curl -fsSL "${AUTH[@]}" "$API" | "$PYTHON" -c "
import json, sys
for a in json.load(sys.stdin)['assets']:
    n = a['name']
    if n.startswith('cpython-${PY_VERSION}.') and n.endswith('x86_64-pc-windows-msvc-install_only.tar.gz'):
        print(a['browser_download_url']); break
")"
[[ -n "$URL" ]] || { echo "no encontré un CPython $PY_VERSION para Windows" >&2; exit 1; }
curl -fsSL "$URL" | tar -xz -C "$BUILD"
mv "$BUILD/python" "$CARGA/runtime"

# lo que no se usa en planta
rm -rf "$CARGA/runtime/Lib/test" "$CARGA/runtime/Lib/tkinter" "$CARGA/runtime/Lib/idlelib" \
       "$CARGA/runtime/tcl" "$CARGA/runtime/include" "$CARGA/runtime/libs"
find "$CARGA/runtime" \( -name '*.pdb' -o -name 'tcl*.dll' -o -name 'tk*.dll' -o -name '_tkinter*' \) -delete
find "$CARGA/runtime" -name '__pycache__' -type d -prune -exec rm -rf {} +
# pythonw con nombre propio: sin consola, y se reconoce en el Administrador de tareas
cp "$CARGA/runtime/pythonw.exe" "$CARGA/runtime/AlignerTrimline.exe"

echo "== librerías"
SITE="$CARGA/runtime/Lib/site-packages"
PYTHONNOUSERSITE=1 "$PYTHON" -m pip install "${PAQUETES[@]}" \
  --target "$SITE" --platform win_amd64 --python-version "$PY_VERSION" --only-binary=:all: \
  --upgrade -q --no-warn-conflicts

# pip con --platform no revisa que el árbol quede completo para Windows: se revisa acá
"$PYTHON" - "$SITE" <<'PY'
import sys
from importlib.metadata import distributions
from packaging.requirements import Requirement

sitio = sys.argv[1]
entorno = {"sys_platform": "win32", "platform_system": "Windows", "platform_machine": "AMD64", "os_name": "nt",
           "python_version": "3.12", "python_full_version": "3.12.0", "implementation_name": "cpython",
           "platform_python_implementation": "CPython", "extra": ""}
norm = lambda n: n.lower().replace("_", "-").replace(".", "-")
hay = {norm(d.metadata["Name"]) for d in distributions(path=[sitio])}
faltan = set()
for d in distributions(path=[sitio]):
    for linea in d.requires or []:
        r = Requirement(linea)
        if (r.marker is None or r.marker.evaluate(entorno)) and norm(r.name) not in hay:
            faltan.add(f"{r.name} (lo pide {d.metadata['Name']})")
if faltan:
    sys.exit("faltan dependencias para Windows:\n  " + "\n  ".join(sorted(faltan)))
print(f"{len(hay)} paquetes, árbol completo")
PY
find "$SITE" -name '__pycache__' -type d -prune -exec rm -rf {} +

echo "== la app"
if [[ -n "$(git -C "$RAIZ" status --porcelain)" ]]; then
  echo "aviso: hay cambios sin commitear; el instalador lleva lo último commiteado" >&2
fi
mkdir -p "$CARGA/app"
git -C "$RAIZ" archive HEAD | tar -x -C "$CARGA/app"
rm -rf "$CARGA/app/packaging" "$CARGA/app/.github" "$CARGA/app/tests" "$CARGA/app/tools" "$CARGA/app/trimline.sh"
# nunca datos de pacientes en un instalador
if find "$CARGA/app" \( -iname '*.stl' -o -iname '*.pts' -o -iname '*.ply' -o -iname '*.3dm' -o -name '.env' \) | grep -q .; then
  echo "hay mallas o datos dentro de la app: no se arma el instalador" >&2
  exit 1
fi

cat > "$CARGA/app-release.json" <<JSON
{
 "tag": "v$VERSION",
 "applied_at": "$(date -u +%Y-%m-%dT%H:%M:%S)",
 "source": "instalador",
 "previous_tag": null
}
JSON

echo "== instalador"
"$MAKENSIS" -V2 -DVERSION="$VERSION" -DCARGA="$CARGA" -DSALIDA="$BUILD/AlignerTrimlineSetup-$VERSION.exe" "$RAIZ/packaging/trimline.nsi"
ls -lh "$BUILD"/AlignerTrimlineSetup-*.exe 2>/dev/null || true
