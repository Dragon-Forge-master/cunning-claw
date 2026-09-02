# Re-cutting the HUD tour

A 76-second tour of the glass — connectors, skills, the Board, the Desk —
narrated in the claw's own voice. Everything on screen is the real software;
the voice is Piper with the same model `setup-voice.sh` installs.

```bash
# 1. His voice, one line per shot (lines.json), into WAVs
for row in $(jq -r '.[] | @base64' lines.json); do
  name=$(echo $row | base64 -d | jq -r '.[0]'); text=$(echo $row | base64 -d | jq -r '.[1]')
  echo "$text" | .venv/bin/piper -m voices/en_GB-alan-medium.onnx --length-scale 0.92 -f lines/$name.wav
done
python3 -c 'import json,wave;print(json.dumps({n:round(wave.open(f"lines/{n}.wav").getnframes()/22050,2) for n,_ in json.load(open("lines.json"))}))' > durs.json

# 2. Record against a running claw (a CLEAN install — no keys, no Telegram, nothing personal)
CLAW_URL=http://127.0.0.1:3900 TOUR_OUT=$PWD node record.mjs      # writes tour2.webm + marks.json

# 3. Lay the voice under it, exactly where each caption appeared
TOUR_OUT=$PWD python3 mux.py                                       # needs ffmpeg with libx264 + aac (pip install imageio-ffmpeg gives one)
```

`record.mjs` logs the second each line starts; `mux.py` drops the WAV in at
that second. Every click has a 3-second ceiling so a blocked control cannot
stall the take — the first cut had thirty silent seconds from exactly that.
