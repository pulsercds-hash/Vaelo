#!/usr/bin/env bash
# Descarga los últimos cambios desde GitHub y reinicia Vaelo.
# Uso:  bash /opt/vaelo/deploy/actualizar.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git pull --ff-only
systemctl restart vaelo
sleep 2
systemctl is-active --quiet vaelo && echo "Vaelo actualizado y funcionando." || journalctl -u vaelo -n 30 --no-pager
