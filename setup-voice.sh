#!/usr/bin/env bash
# Install the Piper neural TTS engine + a voice model for JARVIS.
# Safe to re-run. Everything lands inside this project (.venv/ and voices/).
set -euo pipefail
cd "$(dirname "$0")"

VOICE="${1:-en_GB-alan-medium}"
LANG_DIR="en/en_GB/$(echo "$VOICE" | cut -d- -f2)/$(echo "$VOICE" | cut -d- -f3)"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/$LANG_DIR"

echo "▸ Creating Python venv…"
[ -d .venv ] || python3 -m venv .venv

echo "▸ Installing piper-tts…"
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet piper-tts

echo "▸ Fetching voice model: $VOICE (~60MB)…"
mkdir -p voices
[ -f "voices/$VOICE.onnx" ]      || curl -L --fail --progress-bar -o "voices/$VOICE.onnx"      "$BASE/$VOICE.onnx"
[ -f "voices/$VOICE.onnx.json" ] || curl -L --fail --progress-bar -o "voices/$VOICE.onnx.json" "$BASE/$VOICE.onnx.json"

echo "▸ Testing…"
echo "Good evening, sir. All systems are nominal." \
  | .venv/bin/piper -m "voices/$VOICE.onnx" --output-raw \
  | paplay --raw --rate=22050 --format=s16le --channels=1

echo
echo "✓ Done. Set voice.piper.model to \"voices/$VOICE.onnx\" in jarvis.config.json."
