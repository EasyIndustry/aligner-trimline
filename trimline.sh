#!/usr/bin/env bash
# Abre el programa en Linux desde un checkout: arma el entorno la primera vez y lanza.
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/python lanzador.py "$@"
