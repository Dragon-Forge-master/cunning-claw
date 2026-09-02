// Adar — the claw's ears in the garden. "Adar" is Welsh for birds.
//
// One real capability: record a short clip from the default microphone with
// arecord, send it to the operator's own Gemini key, and ask what bird that
// was. The audio goes to Google and nowhere else; the log keeps only the
// one-line summary, never the recording.
//
// MCP stdio server — run as `node senses/adar.mjs`. The claw spawns it with
// cwd = repo root (src/mcp.ts), which is why the relative path in the
// catalogue works and why workspace/senses resolves correctly here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendJsonl,
  clampNumber,
  errorResult,
  runCommand,
  sensesDataDir,
  serve,
  tailJsonl,
  textResult,
} from "./lib.mjs";

export const GEMINI_MODEL = "gemini-2.5-flash";

/** Same endpoint family as src/imagine.ts — one AIza key hears and paints. */
export function geminiEndpoint(model = GEMINI_MODEL) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export const BIRD_PROMPT =
  "This is a short recording from a garden microphone in the UK. " +
  "Identify any bird species audible: give the common name, the Latin name, " +
  "and how confident you are in each. Mention any other identifiable sounds " +
  "(rain, traffic, voices) briefly. If no birds are audible, say so plainly. " +
  "Answer in plain sentences, no headings.";

export function clampSeconds(raw) {
  return clampNumber(raw, 5, 30, 15);
}

/** Gemini generateContent request: the prompt, then the clip as inline_data. */
export function buildBirdRequest(base64Wav) {
  return {
    contents: [
      {
        parts: [
          { text: BIRD_PROMPT },
          { inline_data: { mime_type: "audio/wav", data: base64Wav } },
        ],
      },
    ],
  };
}

/** Pull the answer text out of a generateContent response. */
export function parseGeminiText(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function logFile() {
  return path.join(sensesDataDir(), "adar-log.jsonl");
}

async function listenForBirds(args) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return errorResult(
      "No GEMINI_API_KEY set — birdsong identification needs one. " +
      "Paste a Google Gemini key on the Keys page (free tier works).",
    );
  }
  const seconds = clampSeconds(args?.seconds);
  const wavPath = path.join(os.tmpdir(), `adar-${process.pid}-${Date.now()}.wav`);
  try {
    // 16 kHz mono S16_LE keeps a 30 s clip under 1 MB — well inside Gemini's
    // inline_data limit — and is plenty for birdsong.
    const rec = await runCommand(
      "arecord",
      ["-d", String(seconds), "-f", "S16_LE", "-r", "16000", "-c", "1", wavPath],
      { timeoutMs: (seconds + 10) * 1000 },
    );
    if (rec.missing) {
      return errorResult(
        "arecord is not installed — `sudo apt install alsa-utils`, then try again.",
      );
    }
    if (rec.code !== 0) {
      return errorResult(
        `arecord failed (exit ${rec.code}) — check that a microphone is plugged in and not ` +
        `claimed by another app. ${rec.stderr.trim().slice(-300)}`,
      );
    }
    let wav;
    try {
      wav = fs.readFileSync(wavPath);
    } catch {
      wav = Buffer.alloc(0);
    }
    if (wav.length < 100) {
      return errorResult("arecord produced no audio — check the microphone.");
    }

    const res = await fetch(geminiEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildBirdRequest(wav.toString("base64"))),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      return errorResult(`Gemini answered HTTP ${res.status}: ${text}`);
    }
    const answer = parseGeminiText(await res.json());
    if (!answer) {
      return errorResult("Gemini answered but sent no text — try a longer recording.");
    }
    // The log keeps the summary, not the audio — a diary, not a surveillance tape.
    appendJsonl(logFile(), { time: new Date().toISOString(), species_summary: answer.slice(0, 400) });
    return textResult(answer);
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* never written */ }
  }
}

async function getRecentSightings() {
  const entries = tailJsonl(logFile(), 20);
  if (!entries.length) {
    return textResult("No sightings logged yet — listen_for_birds starts the diary.");
  }
  const lines = entries.map((e) => `${e.time ?? "(no time)"} — ${e.species_summary ?? "(empty)"}`);
  return textResult(`Last ${entries.length} sighting(s), oldest first:\n${lines.join("\n")}`);
}

export const server = {
  name: "adar",
  version: "0.1.0",
  tools: [
    {
      name: "listen_for_birds",
      description:
        "Record a short clip from the microphone (arecord) and ask Gemini which bird " +
        "species are audible — common and Latin names with confidence. Needs a working " +
        "mic and GEMINI_API_KEY. Each sighting is logged.",
      inputSchema: {
        type: "object",
        properties: {
          seconds: {
            type: "number",
            description: "How long to listen, 5–30 seconds (default 15).",
          },
        },
      },
      handler: listenForBirds,
    },
    {
      name: "get_recent_sightings",
      description: "The last 20 logged bird sightings from workspace/senses/adar-log.jsonl.",
      inputSchema: { type: "object", properties: {} },
      handler: getRecentSightings,
    },
  ],
};

// Only start the stdio loop when run as a program — senses/test.mjs imports
// the pure pieces above without wanting a listener on its stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(server);
}
