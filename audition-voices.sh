#!/usr/bin/env bash
# Audition Piper voice models. Downloads each (~60MB), plays a sample, and
# keeps them in voices/ so you can switch instantly later.
set -uo pipefail
cd "$(dirname "$0")"

LINE="Good evening, sir. All systems are nominal. Shall I run a diagnostic?"
CANDIDATES=(
  "en_GB-alan-medium|en/en_GB/alan/medium|clear neutral British male"
  "en_GB-northern_english_male-medium|en/en_GB/northern_english_male/medium|warmer northern male"
  "en_US-ryan-high|en/en_US/ryan/high|deep American male, highest quality"
  "en_GB-semaine-medium|en/en_GB/semaine/medium|smooth British, expressive"
)

mkdir -p voices
for entry in "${CANDIDATES[@]}"; do
  IFS='|' read -r name dir desc <<< "$entry"
  echo
  echo "── $name — $desc"
  if [ ! -f "voices/$name.onnx" ]; then
    echo "   downloading…"
    BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/$dir"
    curl -sL --fail -o "voices/$name.onnx"      "$BASE/$name.onnx"      || { echo "   ✗ unavailable"; continue; }
    curl -sL --fail -o "voices/$name.onnx.json" "$BASE/$name.onnx.json" || { echo "   ✗ unavailable"; continue; }
  fi
  RATE=$(python3 -c "import json;print(json.load(open('voices/$name.onnx.json'))['audio']['sample_rate'])")
  echo "$LINE" | .venv/bin/piper -m "voices/$name.onnx" --output-raw 2>/dev/null \
    | paplay --raw --rate="$RATE" --format=s16le --channels=1
  sleep 0.5
done

echo
echo "Pick one, then set it in jarvis.config.json:"
echo '  "piper": { "model": "voices/<name>.onnx", "sampleRate": <rate>, ... }'
echo "and restart the server."
