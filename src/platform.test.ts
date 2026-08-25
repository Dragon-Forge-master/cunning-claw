import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  clipboardRead,
  focusWindow,
  listWindows,
  media,
  notify,
  pressKeys,
  screenshot,
  setVolume,
  typeOnDesktop,
} from "./desktop.js";
import {
  hasBin,
  host,
  installHint,
  missing,
  setHasBinForTests,
  setHostForTests,
} from "./platform.js";
import { detect, resetVoiceDetectForTests } from "./voice.js";

afterEach(() => {
  setHostForTests(null);
  setHasBinForTests(null);
  resetVoiceDetectForTests();
});

test("host maps process.platform, with a test override", () => {
  setHostForTests("darwin");
  assert.equal(host(), "darwin");
  setHostForTests("linux");
  assert.equal(host(), "linux");
  setHostForTests(null);
  assert.ok(["linux", "darwin", "other"].includes(host()));
});

test("Linux missing-tool copy names the apt package", () => {
  setHostForTests("linux");
  assert.match(missing("wmctrl"), /sudo apt install wmctrl/);
  assert.match(missing("xdotool"), /sudo apt install xdotool/);
  assert.match(missing("xclip"), /sudo apt install xclip/);
  assert.match(missing("notify-send"), /sudo apt install libnotify-bin/);
  assert.match(missing("pactl"), /sudo apt install pulseaudio-utils/);
  assert.match(missing("paplay"), /sudo apt install pulseaudio-utils/);
  assert.match(missing("playerctl"), /sudo apt install playerctl/);
  assert.match(missing("gnome-screenshot"), /sudo apt install gnome-screenshot/);
  assert.match(missing("spd-say"), /sudo apt install speech-dispatcher/);
  assert.match(missing("piper"), /setup-voice\.sh/);
});

test("macOS missing-tool copy names brew or a privacy setting, never apt", () => {
  setHostForTests("darwin");
  assert.match(missing("screencapture"), /Screen Recording/);
  assert.match(missing("osascript"), /macOS/);
  assert.match(missing("pbcopy"), /macOS/);
  assert.match(missing("afplay"), /macOS/);
  assert.match(missing("ffmpeg"), /brew install ffmpeg/);
  assert.match(missing("playerctl"), /brew install playerctl/);
  assert.doesNotMatch(missing("screencapture"), /sudo apt/);
  assert.doesNotMatch(missing("osascript"), /sudo apt/);
  assert.equal(installHint("wmctrl", "darwin"), undefined);
});

test("a third OS is a message, not a silent no-op", () => {
  setHostForTests("other");
  assert.match(missing("xdotool"), /Linux and macOS/);
});

test("Linux desktop tools name apt when the binary is missing", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);

  assert.match(await listWindows(), /wmctrl/);
  assert.match(await listWindows(), /sudo apt install wmctrl/);
  assert.match(await focusWindow("Terminal"), /sudo apt install wmctrl/);
  assert.match(await pressKeys("ctrl+s"), /sudo apt install xdotool/);
  assert.match(await typeOnDesktop("hi"), /sudo apt install xdotool/);
  assert.match(await notify("t", "b"), /sudo apt install libnotify-bin/);
  assert.match(await clipboardRead(), /sudo apt install xclip/);
  assert.match(await setVolume({ level: 40 }), /sudo apt install pulseaudio-utils/);
  assert.match(await media("playpause"), /playerctl/);
  assert.match(await media("playpause"), /sudo apt install playerctl/);

  const shot = await screenshot();
  assert.equal(shot[0]?.type, "text");
  assert.match((shot[0] as { type: "text"; text: string }).text, /gnome-screenshot/);
  assert.match((shot[0] as { type: "text"; text: string }).text, /sudo apt install/);
});

test("macOS desktop tools name the Darwin binary when it is missing", async () => {
  setHostForTests("darwin");
  setHasBinForTests(() => false);

  assert.match(await listWindows(), /osascript/);
  assert.match(await focusWindow("Terminal"), /osascript/);
  assert.match(await pressKeys("ctrl+s"), /osascript/);
  assert.match(await notify("t", "b"), /osascript/);
  assert.match(await clipboardRead(), /pbpaste/);
  assert.match(await setVolume({ level: 40 }), /osascript/);
  assert.match(await media("next"), /Music|Spotify|playerctl|osascript/);

  const shot = await screenshot();
  assert.equal(shot[0]?.type, "text");
  assert.match((shot[0] as { type: "text"; text: string }).text, /screencapture|Screen Recording/);
});

test("unsupported OS desktop tools refuse with a named message", async () => {
  setHostForTests("other");
  setHasBinForTests(() => false);
  assert.match(await listWindows(), /Linux and macOS/);
  assert.match(await pressKeys("Return"), /Linux and macOS/);
  const shot = await screenshot();
  assert.match((shot[0] as { type: "text"; text: string }).text, /Linux and macOS/);
});

test("voice detect on Darwin falls back to say rather than claiming Piper", async () => {
  setHostForTests("darwin");
  setHasBinForTests((bin) => bin === "say");
  resetVoiceDetectForTests();
  const v = await detect();
  assert.equal(v.engine, "say");
  assert.match(v.detail, /Daniel/i);
});

test("voice detect on Linux with nothing installed names the fix", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  resetVoiceDetectForTests();
  const v = await detect();
  assert.equal(v.engine, "none");
  assert.match(v.detail, /setup-voice\.sh/);
  assert.match(v.detail, /speech-dispatcher|paplay|pulseaudio/);
});

test("hasBin override is wired through platform", async () => {
  setHasBinForTests((bin) => bin === "wmctrl");
  assert.equal(await hasBin("wmctrl"), true);
  assert.equal(await hasBin("xdotool"), false);
});
