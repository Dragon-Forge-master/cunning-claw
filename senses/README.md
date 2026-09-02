# The senses

Three small first-party MCP servers that give CUNNING CLAW senses beyond the
screen. Plain Node 22 ESM, zero dependencies, spoken to over stdio — the same
newline-delimited JSON-RPC the claw already speaks to any local server
(`src/mcp.ts`). Their Welsh names are their jobs.

| Sense | What it does | Hardware it needs |
| --- | --- | --- |
| **Adar** (birds) — `senses/adar.mjs` | Records a short clip from the microphone and asks Gemini which bird species are audible; keeps a sightings diary in `workspace/senses/adar-log.jsonl`. | A working microphone, `arecord` (`sudo apt install alsa-utils`), and a `GEMINI_API_KEY` on the Keys page. |
| **Llygad** (eye) — `senses/llygad.mjs` | An unprivileged presence radar: pings the local /24, reads `ip neigh`, and reports which known devices are home. Name your devices by copying `devices.example.json` to `senses/devices.json`. | A local network and `iproute2` — no root, no raw sockets. |
| **Uwchben** (above) — `senses/uwchben.mjs` | What's overhead: nearby aircraft from adsb.lol (defaulting to Cardiff) and the live ISS position from wheretheiss.at. | Nothing but an internet connection. |

## Connecting them from the HUD

All three are in the connector catalogue, so they appear on the **CONNECT**
sheet — Adar under **AI**, Llygad and Uwchben under **Data**. Click Connect and
the claw spawns the script itself (`node senses/<name>.mjs`, from the repo
root); there is no sign-in, no URL, nothing to install beyond the hardware
above. `mcp.enabled` must be true in `claw.config.json`, as for any connector.

## Local-first, honestly

- **Audio goes to one place**: the operator's own Gemini key, as a single
  `generateContent` call. The recording is a temp file deleted after the call;
  the diary keeps only the one-line summary, never the sound.
- **The network scan never leaves the LAN.** Ping and the kernel's neighbour
  table, nothing else — and the report says plainly that a phone in deep sleep
  can look absent when its owner is home.
- **ADS-B and the ISS are public feeds** (api.adsb.lol, api.wheretheiss.at).
  The only thing sent is the coordinates being asked about.

## Tests

`node senses/test.mjs` — zero-dependency, no network, no microphone. It covers
the shared JSON-RPC framing in `lib.mjs`, each sense's pure logic, and a real
stdio round-trip: every server is spawned and driven with the exact framing
`src/mcp.ts` uses. Not wired into `npm test` (that suite is `src/*.test.ts`);
run it alongside in CI.
