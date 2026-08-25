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

play_raw() {
  if command -v paplay >/dev/null 2>&1; then
    paplay --raw --rate=22050 --format=s16le --channels=1
    return
  fi
  if command -v afplay >/dev/null 2>&1; then
    local wav
    wav="$(mktemp "${TMPDIR:-/tmp}/jarvis-voice.XXXXXX").wav"
    python3 - "$wav" <<'PY'
import sys, wave
path = sys.argv[1]
raw = sys.stdin.buffer.read()
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(22050)
    w.writeframes(raw)
PY
    afplay "$wav"
    rm -f "$wav"
    return
  fi
  echo "No audio player found (paplay on Linux, afplay on macOS). The model is installed; playback needs a player." >&2
  cat >/dev/null
}

echo "▸ Testing…"
echo "Good evening, sir. All systems are nominal." \
  | .venv/bin/piper -m "voices/$VOICE.onnx" --output-raw \
  | play_raw

echo
echo "✓ Done. Set voice.piper.model to \"voices/$VOICE.onnx\" in jarvis.config.json."
