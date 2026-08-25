import assert from "node:assert/strict";
import test from "node:test";
import { cleanForSpeech, wrapPcmToWav } from "./voice.js";

test("WAV wrapper is a real RIFF header over the PCM payload", () => {
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const wav = wrapPcmToWav(pcm, 22050);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.subarray(44).equals(pcm), true);
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

test("cleanForSpeech strips markdown so it is not read aloud", () => {
  const out = cleanForSpeech("See [docs](https://example.com) and `code`.");
  assert.match(out, /docs/);
  assert.match(out, /code/);
  assert.doesNotMatch(out, /https/);
  assert.doesNotMatch(out, /`/);
});
