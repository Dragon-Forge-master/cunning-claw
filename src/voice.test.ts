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

test("the prompt can read what detect() found without waiting, and never mistakes 'not looked' for 'no voice'", async () => {
  // The claw once offered to build offline speech it already had, because
  // nothing told it what engine was installed. The stable prompt now reads
  // this synchronously each turn; before detect() has run it must say so
  // rather than report an absent voice.
  const { detected, detect, resetVoiceDetectForTests } = await import("./voice.js");
  resetVoiceDetectForTests();
  assert.equal(detected(), null, "not looked yet is null, not 'none'");
  const found = await detect();
  const seen = detected();
  assert.ok(seen, "cached after detect()");
  assert.equal(seen?.engine, found.engine);
  assert.equal(seen?.detail, found.detail);
});
