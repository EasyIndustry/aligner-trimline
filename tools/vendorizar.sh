#!/usr/bin/env bash
# Trae una versión fija de uno de los motores three.js a web/vendor/<motor>/.
#
#   tools/vendorizar.sh render     v0.8.0-rc.1
#   tools/vendorizar.sh sdk        v0.8.0-rc.2
#   tools/vendorizar.sh materiales v0.2.0
#
# El segundo argumento es una etiqueta o un commit completo (nunca abreviado). Deja dos archivos
# que dicen qué hay:
#   VERSION    la versión del package.json, lo que se pidió y el commit exacto
#   MANIFEST   el sha256 de cada archivo copiado
#
# La copia NO se edita acá: un arreglo va al repo del motor, sale en una versión y se vuelve a
# vendorizar. tests/test_vendor.py compara contra MANIFEST y falla si alguien la tocó.
set -euo pipefail

MOTOR="${1:?uso: tools/vendorizar.sh <render|sdk|materiales> <etiqueta o commit completo>}"
REF="${2:?uso: tools/vendorizar.sh <render|sdk|materiales> <etiqueta o commit completo>}"
if [[ "$REF" =~ ^[0-9a-f]{4,39}$ ]]; then
  echo "\"$REF\" parece un commit abreviado: va el hash completo." >&2
  exit 1
fi
case "$MOTOR" in
  render)     NOMBRE="threejs-render-engine";   REPO="EasyIndustry/threejs-render-engine"; COPIA="src LICENSE" ;;
  sdk)        NOMBRE="threejs-cad-sdk";         REPO="EasyIndustry/ThreeJS-cad-SDK";       COPIA="src adapters LICENSE" ;;
  materiales) NOMBRE="threejs-material-engine"; REPO="EasyIndustry/threejs-material-engine"; COPIA="src adapters LICENSE" ;;
  *) echo "motor desconocido: $MOTOR (render, sdk o materiales)" >&2; exit 1 ;;
esac
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$RAIZ/web/vendor/$NOMBRE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" remote add origin "https://github.com/$REPO.git"
git -C "$TMP" fetch -q --depth 1 origin "$REF"
git -C "$TMP" checkout -q FETCH_HEAD
SHA="$(git -C "$TMP" rev-parse HEAD)"
VERSION="$(node -p "require('$TMP/package.json').version")"

rm -rf "$DEST"
mkdir -p "$DEST"
# shellcheck disable=SC2086
(cd "$TMP" && cp -r $COPIA "$DEST/")
echo "$VERSION $REF $SHA" > "$DEST/VERSION"
# shellcheck disable=SC2086
(cd "$DEST" && find $COPIA -type f | LC_ALL=C sort | xargs sha256sum > MANIFEST)

echo "$NOMBRE $VERSION ($REF, ${SHA:0:7}) en web/vendor/$NOMBRE/"
echo "$(wc -l < "$DEST/MANIFEST") archivos."
