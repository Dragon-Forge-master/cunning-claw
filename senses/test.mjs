// Tests for the senses — plain Node, zero dependencies, in the style of
// relay/test.mjs. Run with `node senses/test.mjs`. Nothing here touches the
// network, the microphone, or the LAN: the pure logic is tested directly, and
// the wire framing is proven by spawning each server and speaking to it the
// way src/mcp.ts does — newline-delimited JSON-RPC matched by id.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clampNumber,
  createLineParser,
  errorResult,
  handleMessage,
  textResult,
} from "./lib.mjs";
import {
  BIRD_PROMPT,
  buildBirdRequest,
  clampSeconds,
  geminiEndpoint,
  parseGeminiText,
} from "./adar.mjs";
import {
  deriveSubnet,
  formatHomeReport,
  mergeNames,
  parseNeigh,
  pingTargets,
  validSubnet,
} from "./llygad.mjs";
import {
  buildAdsbUrl,
  clampRadiusKm,
  describeAircraft,
  formatIss,
  formatOverhead,
  kmToNm,
  roughRegion,
} from "./uwchben.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// --- lib: line framing ------------------------------------------------------

test("line parser reassembles a message split across chunks", () => {
  const got = [];
  const feed = createLineParser((m) => got.push(m));
  feed(Buffer.from('{"jsonrpc":"2.0","id":1,'));
  feed(Buffer.from('"method":"ping"}\n'));
  assert.deepEqual(got, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("line parser handles several messages in one chunk and skips garbage", () => {
  const got = [];
  const feed = createLineParser((m) => got.push(m));
  feed(Buffer.from('{"id":1}\nnot json\n\n{"id":2}\n'));
  assert.deepEqual(got.map((m) => m.id), [1, 2]);
});

// --- lib: JSON-RPC handling -------------------------------------------------

const FAKE = {
  name: "fake",
  version: "9.9.9",
  tools: [
    {
      name: "get_thing",
      description: "A thing.",
      inputSchema: { type: "object", properties: {} },
      handler: async (args) => textResult(`thing:${args.x ?? "-"}`),
    },
    {
      name: "explode",
      description: "Always throws.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => { throw new Error("boom"); },
    },
  ],
};

test("initialize echoes the client's protocolVersion and declares tools", async () => {
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    FAKE,
  );
  assert.equal(res.id, 7);
  assert.equal(res.result.protocolVersion, "2025-03-26");
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.deepEqual(res.result.serverInfo, { name: "fake", version: "9.9.9" });
});

test("an id-less notification gets silence, not a reply", async () => {
  const res = await handleMessage(
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    FAKE,
  );
  assert.equal(res, null);
});

test("tools/list returns names, descriptions and schemas but never handlers", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, FAKE);
  assert.deepEqual(res.result.tools.map((t) => t.name), ["get_thing", "explode"]);
  assert.equal(res.result.tools[0].handler, undefined);
  assert.equal(res.result.tools[0].inputSchema.type, "object");
});

test("tools/call dispatches with arguments and returns MCP content blocks", async () => {
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_thing", arguments: { x: 5 } } },
    FAKE,
  );
  assert.deepEqual(res.result.content, [{ type: "text", text: "thing:5" }]);
  assert.equal(res.result.isError, undefined);
});

test("a throwing handler becomes an isError result, not a protocol error", async () => {
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "explode" } },
    FAKE,
  );
  assert.equal(res.error, undefined, "must stay a result the model can read");
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /boom/);
});

test("unknown tool and unknown method are JSON-RPC errors with the right codes", async () => {
  const badTool = await handleMessage(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } },
    FAKE,
  );
  assert.equal(badTool.error.code, -32602);
  const badMethod = await handleMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" }, FAKE);
  assert.equal(badMethod.error.code, -32601);
});

test("textResult and errorResult carry the MCP content-block shape", () => {
  assert.deepEqual(textResult("hi"), { content: [{ type: "text", text: "hi" }] });
  const err = errorResult("bad");
  assert.equal(err.isError, true);
  assert.equal(err.content[0].type, "text");
});

test("clampNumber clamps, rounds, and falls back on garbage", () => {
  assert.equal(clampNumber(7, 5, 30, 15), 7);
  assert.equal(clampNumber(999, 5, 30, 15), 30);
  assert.equal(clampNumber(-1, 5, 30, 15), 5);
  assert.equal(clampNumber("chicken", 5, 30, 15), 15);
  assert.equal(clampNumber(undefined, 5, 30, 15), 15);
});

// --- adar -------------------------------------------------------------------

test("clampSeconds keeps recordings between 5 and 30 seconds, defaulting to 15", () => {
  assert.equal(clampSeconds(undefined), 15);
  assert.equal(clampSeconds(2), 5);
  assert.equal(clampSeconds(300), 30);
  assert.equal(clampSeconds(20), 20);
});

test("the Gemini request carries the clip as inline_data audio/wav plus the prompt", () => {
  const req = buildBirdRequest("QUJD");
  const parts = req.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, BIRD_PROMPT);
  assert.equal(parts[1].inline_data.mime_type, "audio/wav");
  assert.equal(parts[1].inline_data.data, "QUJD");
});

test("the bird prompt asks for species, Latin names, confidence and other sounds", () => {
  assert.match(BIRD_PROMPT, /bird species/i);
  assert.match(BIRD_PROMPT, /Latin name/i);
  assert.match(BIRD_PROMPT, /confiden/i);
  assert.match(BIRD_PROMPT, /other identifiable sounds/i);
});

test("the adar endpoint targets gemini-2.5-flash generateContent", () => {
  assert.equal(
    geminiEndpoint(),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
});

test("parseGeminiText joins candidate text parts and survives junk", () => {
  const body = { candidates: [{ content: { parts: [{ text: "A robin." }, { other: 1 }, { text: "Rain too." }] } }] };
  assert.equal(parseGeminiText(body), "A robin.\nRain too.");
  assert.equal(parseGeminiText({}), "");
  assert.equal(parseGeminiText(null), "");
});

// --- llygad -----------------------------------------------------------------

const IP_ROUTE_FIXTURE = [
  "default via 192.168.1.1 dev wlp2s0 proto dhcp src 192.168.1.42 metric 600",
  "192.168.1.0/24 dev wlp2s0 proto kernel scope link src 192.168.1.42 metric 600",
].join("\n");

test("deriveSubnet reads the default route's src address", () => {
  assert.equal(deriveSubnet(IP_ROUTE_FIXTURE), "192.168.1");
});

test("deriveSubnet falls back to any src line, and null with none", () => {
  assert.equal(
    deriveSubnet("default via 10.0.0.1 dev eth0\n10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.7"),
    "10.0.0",
  );
  assert.equal(deriveSubnet(""), null);
  assert.equal(deriveSubnet("unreachable default"), null);
});

test("validSubnet accepts three octets and rejects everything else", () => {
  assert.equal(validSubnet("192.168.1"), true);
  assert.equal(validSubnet("10.0.0"), true);
  assert.equal(validSubnet("192.168.1.0"), false);
  assert.equal(validSubnet("999.1.1"), false);
  assert.equal(validSubnet("192.168"), false);
  assert.equal(validSubnet("192.168.1; rm -rf /"), false);
});

test("pingTargets covers .1 through .254 and nothing else", () => {
  const t = pingTargets("192.168.1");
  assert.equal(t.length, 254);
  assert.equal(t[0], "192.168.1.1");
  assert.equal(t[253], "192.168.1.254");
  assert.equal(t.includes("192.168.1.0"), false);
  assert.equal(t.includes("192.168.1.255"), false);
});

const NEIGH_FIXTURE = [
  "192.168.1.1 dev wlp2s0 lladdr aa:bb:cc:dd:ee:01 REACHABLE",
  "192.168.1.23 dev wlp2s0 lladdr AA:BB:CC:DD:EE:02 STALE",
  "192.168.1.99 dev wlp2s0 FAILED",
  "192.168.1.50 dev wlp2s0 INCOMPLETE",
  "fe80::1 dev wlp2s0 lladdr aa:bb:cc:dd:ee:03 router REACHABLE",
].join("\n");

test("parseNeigh keeps REACHABLE/STALE IPv4 entries with MACs, lowercased", () => {
  const entries = parseNeigh(NEIGH_FIXTURE);
  assert.deepEqual(entries, [
    { ip: "192.168.1.1", mac: "aa:bb:cc:dd:ee:01", state: "REACHABLE" },
    { ip: "192.168.1.23", mac: "aa:bb:cc:dd:ee:02", state: "STALE" },
  ]);
});

test("mergeNames matches devices.json MACs case-insensitively and counts strangers", () => {
  const entries = parseNeigh(NEIGH_FIXTURE);
  const { named, unnamed } = mergeNames(entries, { "AA:BB:CC:DD:EE:02": "Chris's phone" });
  assert.equal(named.length, 1);
  assert.equal(named[0].name, "Chris's phone");
  assert.equal(named[0].ip, "192.168.1.23");
  assert.equal(unnamed, 1);
});

test("the home report is honest about sleeping phones", () => {
  const report = formatHomeReport([{ name: "Chris's phone", ip: "192.168.1.23", state: "STALE" }], 3, "192.168.1");
  assert.match(report, /Chris's phone — 192\.168\.1\.23/);
  assert.match(report, /3 unnamed devices/);
  assert.match(report, /deep sleep/);
});

// --- uwchben ----------------------------------------------------------------

test("kmToNm uses the international nautical mile", () => {
  assert.equal(kmToNm(1.852), 1);
  assert.equal(kmToNm(18.52), 10);
});

test("buildAdsbUrl converts km to whole nautical miles at the vendor endpoint", () => {
  // 25 km / 1.852 = 13.499 nm → 13
  assert.equal(buildAdsbUrl(51.48, -3.18, 25), "https://api.adsb.lol/v2/point/51.48/-3.18/13");
});

test("buildAdsbUrl clamps the radius to 1–100 km and never asks for 0 nm", () => {
  assert.equal(buildAdsbUrl(0, 0, 5000), "https://api.adsb.lol/v2/point/0/0/54");
  assert.equal(buildAdsbUrl(0, 0, 0.1), "https://api.adsb.lol/v2/point/0/0/1");
  assert.equal(clampRadiusKm("garbage"), 25);
});

test("describeAircraft claims only the fields the feed sent", () => {
  const full = describeAircraft({ flight: "BAW123 ", t: "A320", alt_baro: 35000, gs: 447.2, track: 271.8 });
  assert.match(full, /Flight BAW123, a A320, at 35,000 ft, doing 447 kt, heading 272°\./);
  const bare = describeAircraft({});
  assert.match(bare, /no callsign/);
  assert.doesNotMatch(bare, /\d| ft| kt|°/);
  assert.match(describeAircraft({ flight: "X", alt_baro: "ground" }), /on the ground/);
});

test("formatOverhead caps the list at 15 and treats an empty sky as a fine answer", () => {
  const many = { ac: Array.from({ length: 20 }, (_, i) => ({ flight: `TST${i}` })) };
  const text = formatOverhead(many, 51.48, -3.18, 25);
  assert.match(text, /20 aircraft/);
  assert.equal(text.split("\n").filter((l) => l.includes("Flight TST")).length, 15);
  assert.match(text, /5 more not listed/);
  assert.match(formatOverhead({ ac: [] }, 51.48, -3.18, 25), /Empty sky/);
});

test("roughRegion only names an ocean when the box makes it trivially true", () => {
  assert.equal(roughRegion(-30, -20), "over the South Atlantic");
  assert.equal(roughRegion(-70, 100), "over the Southern Ocean");
  assert.equal(roughRegion(51.48, -3.18), null, "Cardiff is not an ocean");
  assert.equal(roughRegion(40, -100), null, "Kansas is not an ocean");
});

test("formatIss reports position, altitude and velocity, coordinates when unsure", () => {
  const text = formatIss({ latitude: 51.5, longitude: -3.2, altitude: 417.3, velocity: 27571.4 });
  assert.match(text, /51\.50, -3\.20/);
  assert.match(text, /417 km/);
  assert.match(text, /27,571 km\/h/);
  assert.doesNotMatch(text, /Atlantic|Pacific|Indian|Southern/);
  assert.match(formatIss({ latitude: -30, longitude: -20, altitude: 420, velocity: 27000 }), /South Atlantic/);
});

// --- stdio round-trip -------------------------------------------------------
// Spawn each server for real and speak to it exactly the way src/mcp.ts does:
// one JSON object per line, replies matched by id, silence for notifications.

function rpcSession(script) {
  const child = spawn(process.execPath, [script], {
    cwd: path.dirname(HERE), // repo root — the same cwd the claw spawns with
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = [];
  const waiters = new Map();
  // Mirror of the claw's onData framing, written independently on purpose.
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      const msg = JSON.parse(text);
      responses.push(msg);
      waiters.get(msg.id)?.(msg);
    }
  });
  return {
    responses,
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    waitFor(id, ms = 5000) {
      const hit = responses.find((r) => r.id === id);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply for id ${id} from ${script}`)), ms);
        waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    kill() {
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}

async function roundTrip(name, expectedTools) {
  const session = rpcSession(path.join(HERE, `${name}.mjs`));
  try {
    session.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cunningclaw", version: "0.2.0" } } });
    const init = await session.waitFor(1);
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, name);
    assert.deepEqual(init.result.capabilities, { tools: {} });

    // A notification between two requests. stdin is processed in order, so if
    // the server wrongly answered it, that stray line would land before the
    // id-2 reply and the count below would catch it.
    session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await session.waitFor(2);
    assert.deepEqual(list.result.tools.map((t) => t.name), expectedTools);
    for (const t of list.result.tools) {
      assert.ok(t.description.length > 20, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, "object");
    }
    assert.equal(session.responses.length, 2, "the notification must get silence");
  } finally {
    session.kill();
  }
}

test("adar answers the real wire: initialize, silent notification, tools/list", async () => {
  await roundTrip("adar", ["listen_for_birds", "get_recent_sightings"]);
});

test("llygad answers the real wire: initialize, silent notification, tools/list", async () => {
  await roundTrip("llygad", ["get_devices_home", "get_presence_change"]);
});

test("uwchben answers the real wire: initialize, silent notification, tools/list", async () => {
  await roundTrip("uwchben", ["get_whats_overhead", "get_iss_position"]);
});

test("a missing GEMINI_API_KEY is a business failure over the wire, not a crash", async () => {
  const session = rpcSession(path.join(HERE, "adar.mjs"));
  try {
    // The child inherits our env minus the key — spawn again with it stripped.
    session.kill();
    const child = spawn(process.execPath, [path.join(HERE, "adar.mjs")], {
      cwd: path.dirname(HERE),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GEMINI_API_KEY: "" },
    });
    let buffer = "";
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no tools/call reply")), 5000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        for (const line of buffer.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 2) { clearTimeout(timer); resolve(msg); }
          } catch { /* partial line */ }
        }
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listen_for_birds", arguments: {} } }) + "\n");
    const msg = await got;
    try {
      assert.equal(msg.result.isError, true);
      assert.match(msg.result.content[0].text, /GEMINI_API_KEY/);
      assert.match(msg.result.content[0].text, /Keys page/);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  } finally {
    session.kill();
  }
});

await runAll();
