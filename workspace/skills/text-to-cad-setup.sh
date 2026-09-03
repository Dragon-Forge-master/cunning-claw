#!/usr/bin/env bash
# One-time setup for the vendored `cad` and `dxf` skills (earthtojake/text-to-cad, MIT).
# The repo carries only their SKILL.md and references; this fetches the runtime:
# the skills' scripts/ directories (pinned to the vendored version) and a private
# Python venv with the cadgen package. Nothing here touches the system Python.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="v0.4.28"
VENV="$HERE/.venv-cad"

command -v python3 >/dev/null || { echo "python3 is required (3.11+)"; exit 1; }
command -v node >/dev/null || { echo "node is required for DXF previews"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }

TMP="$(mktemp -d)"
git clone -q --depth 1 --branch "$VERSION" --no-checkout https://github.com/earthtojake/text-to-cad.git "$TMP/t2c" \
  || git clone -q --depth 1 --no-checkout https://github.com/earthtojake/text-to-cad.git "$TMP/t2c"
( cd "$TMP/t2c" && git sparse-checkout init --cone >/dev/null && git sparse-checkout set skills/cad/scripts skills/dxf/scripts >/dev/null && git checkout -q )
for s in cad dxf; do
  rm -rf "$HERE/$s/scripts"
  cp -r "$TMP/t2c/skills/$s/scripts" "$HERE/$s/scripts"
done
rm -rf "$TMP"

[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$HERE/cad/requirements.txt"

echo "text-to-cad runtime ready."
echo "  scripts: $HERE/cad/scripts  $HERE/dxf/scripts"
echo "  python:  $VENV/bin/python   (use this interpreter for the skills' commands)"
