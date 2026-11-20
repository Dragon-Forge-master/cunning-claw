#!/usr/bin/env bash
# Install whisper.cpp (local speech-to-text) + a model for CUNNING CLAW's mic.
# Safe to re-run. Everything lands inside this project (.whisper/ and models/),
# where src/ears.ts looks with no config. Usage: ./setup-ears.sh [base.en]
set -euo pipefail
# An installed app's own folder is read-only (an AppImage, a .app): what this
# installs goes in the owner's folder instead, where the claw looks for it
# (src/home-root.ts). A clone or an unzipped download is its own folder.
here="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${CLAW_HOME:-}" ]; then
  target="$CLAW_HOME"
elif [ -f "$here/installed.json" ]; then
  case "$(uname -s)" in
    Darwin) target="$HOME/Library/Application Support/cunningclaw" ;;
    *) case "${XDG_DATA_HOME:-}" in /*) target="$XDG_DATA_HOME/cunningclaw" ;; *) target="$HOME/.local/share/cunningclaw" ;; esac ;;
  esac
else
  target="$here"
fi
mkdir -p "$target"
cd "$target"

MODEL="${1:-base.en}"
case "$MODEL" in
  *[!A-Za-z0-9._-]*|"") echo "Model names are letters, digits, '.', '_' and '-' (e.g. base.en, small.en, tiny.en)." >&2; exit 2 ;;
esac
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

BIN=""
if command -v whisper-cli >/dev/null 2>&1; then
  BIN="$(command -v whisper-cli)"
  echo "▸ whisper-cli already on PATH: $BIN"
elif [ -x .whisper/bin/whisper-cli ]; then
  BIN=".whisper/bin/whisper-cli"
  echo "▸ whisper-cli already built: $BIN"
elif [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
  echo "▸ Installing whisper-cpp with Homebrew…"
  brew install whisper-cpp
  BIN="$(command -v whisper-cli || command -v whisper-cpp)"
else
  for tool in git cmake c++; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "✗ $tool is needed to build whisper.cpp. On Debian/Ubuntu: sudo apt install git cmake build-essential" >&2
      exit 1
    fi
  done
  echo "▸ Fetching whisper.cpp source (github.com/ggml-org/whisper.cpp)…"
  if [ -d .whisper/src/.git ]; then
    git -C .whisper/src pull --ff-only --quiet
  else
    mkdir -p .whisper
    git clone --depth 1 --quiet https://github.com/ggml-org/whisper.cpp .whisper/src
  fi
  echo "▸ Building whisper-cli (CPU; a few minutes)…"
  cmake -S .whisper/src -B .whisper/build -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null
  cmake --build .whisper/build --config Release --target whisper-cli -j >/dev/null
  mkdir -p .whisper/bin
  cp .whisper/build/bin/whisper-cli .whisper/bin/whisper-cli
  BIN=".whisper/bin/whisper-cli"
fi

echo "▸ Fetching model: ggml-$MODEL.bin (base.en is ~150MB)…"
mkdir -p models
[ -f "models/ggml-$MODEL.bin" ] || curl -L --fail --progress-bar -o "models/ggml-$MODEL.bin.part" "$BASE/ggml-$MODEL.bin"
[ -f "models/ggml-$MODEL.bin.part" ] && mv "models/ggml-$MODEL.bin.part" "models/ggml-$MODEL.bin"

if [ -f .whisper/src/samples/jfk.wav ]; then
  echo "▸ Testing…"
  "$BIN" -m "models/ggml-$MODEL.bin" -f .whisper/src/samples/jfk.wav -nt -np
fi

echo
echo "✓ Done. Restart CUNNING CLAW (or reload the HUD); the mic says LOCAL EARS."
echo "  Nothing to configure: the binary in .whisper/ or on PATH and the model in models/ are found."
