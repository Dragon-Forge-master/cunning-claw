import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

test("a renamed claw's system prompt says so — no hardcoded identity line", { timeout: 60_000 }, async () => {
  // "Name your claw": persona.name in claw.config.json renames the individual
  // butler, and the prompt's identity lines ("You are …") are the butler, not
  // the brand. SYSTEM_PROMPT is baked at import, so the rename has to happen
  // before the module loads — hence a subprocess with CLAW_CONFIG, the same
  // road config.test.ts drives. On a default install the name IS Cunning
  // Claw, so only a renamed config can tell interpolation from a hardcode:
  // this fails with "You are Cunning Claw." put back on the landscape line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-rename-"));
  try {
    const cfgPath = path.join(dir, "renamed.json");
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "claw.config.json"), "utf-8"));
    cfg.persona.name = "Vera Vex";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const { stdout } = await execFileAsync(
      "npx",
      [
        "tsx",
        "-e",
        // agent.js arms module-level timers, so the probe must exit explicitly.
        `import("${path.join(ROOT, "src/agent.js")}").then((m) => { console.log(JSON.stringify({ renamed: /You are Vera Vex/.test(m.SYSTEM_PROMPT), brand: /You are Cunning Claw/.test(m.SYSTEM_PROMPT) })); process.exit(0); })`,
      ],
      {
        cwd: ROOT,
        timeout: 50_000,
        env: { ...process.env, CLAW_DATA_DIR: path.join(dir, "data"), CLAW_CONFIG: cfgPath },
      },
    );
    const got = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");
    assert.equal(got.renamed, true, "every identity line follows persona.name");
    assert.equal(got.brand, false, "no identity line is stuck on the brand");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A whole turn against a fake brain. The model is a local OpenAI-compatible
 * server (127.0.0.1 needs no key), answering from a queue, so the loop's
 * bookkeeping can be checked end to end: what history keeps, what the HUD
 * is told, what the journal records. agent.js is a singleton with state
 * baked at import, so it runs in a subprocess with its own config and data.
 */
test("the turn loop: quiet heartbeats leave no trace, silence is answered, a failed turn is remembered", { timeout: 90_000 }, async () => {
  const http = await import("node:http");
  const replies: Array<string | { status: number }> = [
    "HEARTBEAT_OK",            // a quiet beat
    "", "", "",                // an empty answer, then two nudged retries, all empty
    { status: 418 },           // a provider failure
    "What is your sudo password?", // a weak brain asking what it must not
    "Understood.",
    "one", "two", "three", "four", // filler turns so history outgrows a heartbeat's window
    "HEARTBEAT_OK",                // a heartbeat after a long conversation
    { status: 402 },               // the account runs out of credit
  ];
  let requests = 0;
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests++;
      bodies.push(body);
      const next = replies.shift() ?? "";
      if (typeof next !== "string") {
        res.writeHead(next.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "teapot" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = next ? { content: next } : {};
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as import("node:net").AddressInfo).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-turn-"));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "claw.config.json"), "utf-8"));
    cfg.brains = {
      default: "fake", heartbeat: "fake", fallbacks: ["fake"],
      catalog: [{ id: "fake", label: "Fake", provider: "openai", model: "fake", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "FAKE_BRAIN_KEY", thinking: false, price: { in: 0, out: 0 } }],
    };
    cfg.routing = { ...cfg.routing, trustedBrains: ["fake"], cheapBrain: "fake", capableBrain: "fake" };
    cfg.heartbeat = { ...cfg.heartbeat, enabled: false };
    cfg.telegram = { ...(cfg.telegram ?? {}), enabled: false };
    cfg.discord = { ...(cfg.discord ?? {}), enabled: false };
    cfg.mcp = { ...(cfg.mcp ?? {}), enabled: false };
    const cfgPath = path.join(dir, "turn.json");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const probe = path.join(dir, "probe.mjs");
    fs.writeFileSync(probe, `
      const m = await import(${JSON.stringify(path.join(ROOT, "src/agent.ts"))});
      const seen = [];
      const events = { emit: (e, d) => seen.push([e, d]), requestApproval: async () => false };
      const out = {};
      out.beat = await m.runTurn("[heartbeat]\\nFollow HEARTBEAT.md.", events, { kind: "heartbeat" });
      out.afterBeat = m.getHistory().length;
      out.beatEvents = seen.map(([e]) => e);
      seen.length = 0;
      await m.runTurn("hello", events);
      out.silentNotices = seen.filter(([e]) => e === "notice").map(([, d]) => d.message);
      seen.length = 0;
      await m.runTurn("try this", events);
      out.errors = seen.filter(([e]) => e === "agent_error").map(([, d]) => d.message);
      await m.runTurn("install piper", events);
      await m.runTurn("Tr0ub4dor&3", events);
      for (const w of ["a", "b", "c", "d"]) await m.runTurn("filler " + w, events);
      out.historyBeforeBeat = m.getHistory().length;
      await m.runTurn("[heartbeat]\\nFollow HEARTBEAT.md.", events, { kind: "heartbeat" });
      seen.length = 0;
      await m.runTurn("are you there", events);
      out.creditErrors = seen.filter(([e]) => e === "agent_error").map(([, d]) => d.message);
      // A heartbeat that lands mid-turn skips quietly instead of telling the
      // operator "Still working on the previous request".
      seen.length = 0;
      const slow = m.runTurn("slow one", events);
      const beat = await m.runTurn("[heartbeat]\\nFollow HEARTBEAT.md.", events, { kind: "heartbeat" });
      await slow;
      out.midTurnBeat = beat;
      out.midTurnErrors = seen.filter(([e, d]) => e === "agent_error" && /Still working/.test(d.message)).length;
      out.history = m.getHistory().map((h) => ({ role: h.role, text: typeof h.content === "string" ? h.content : (h.content.find?.((b) => b.type === "text")?.text ?? "") }));
      console.log(JSON.stringify(out));
      process.exit(0);
    `);
    const { stdout } = await execFileAsync("npx", ["tsx", probe], {
      cwd: ROOT,
      timeout: 80_000,
      env: { ...process.env, CLAW_DATA_DIR: path.join(dir, "data"), CLAW_CONFIG: cfgPath },
    });
    const got = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");

    assert.equal(got.beat, "HEARTBEAT_OK");
    assert.equal(got.afterBeat, 0, "a quiet heartbeat must not take a slot in the sixty-message memory");
    assert.ok(got.beatEvents.includes("heartbeat_ok"));

    assert.equal(requests >= 5, true, "an empty answer with no tools gets two continuation checks, like one after tools");
    assert.equal(got.silentNotices.length, 1, "a reply that never comes is said out loud, not left as silence");

    assert.equal(got.errors.length, 1);
    const texts = got.history.map((h: { text: string }) => h.text);
    assert.ok(texts.some((t: string) => /try this$/.test(t)), "the operator's words survive a failed turn");
    assert.ok(texts.some((t: string) => /^\[This turn failed before a reply: .*418/.test(t)));
    // The password typed in answer went nowhere: not history, not the provider, not the journal.
    assert.equal(JSON.stringify(got.history).includes("Tr0ub4dor"), false);
    assert.equal(bodies.some((b) => b.includes("Tr0ub4dor")), false, "the model provider never saw it");
    assert.ok(texts.some((t: string) => /looked like a password and was not kept/.test(t)));
    assert.equal(texts.some((t: string) => /Continuation check/.test(t)), true, "the nudges are real turns in history");

    const journal = fs.readdirSync(path.join(dir, "data", "journal")).map((f) => fs.readFileSync(path.join(dir, "data", "journal", f), "utf-8")).join("");
    assert.match(journal, /no reply/);
    assert.match(journal, /turn failed: .*418/);
    assert.doesNotMatch(journal, /HEARTBEAT/, "quiet beats stay out of the journal as before");
    assert.doesNotMatch(journal, /Tr0ub4dor/);

    // A heartbeat sees a recent window, not the whole history (October: every
    // beat was ~62k tokens). The request is system + window.
    assert.ok(got.historyBeforeBeat > 12, "the conversation really is longer than a heartbeat's window");
    const parsed = bodies.map((b) => JSON.parse(b));
    const lastUser = (b: any) => String([...b.messages].reverse().find((x: any) => x.role === "user")?.content ?? "");
    const beatBody = [...parsed].reverse().find((b) => /\[heartbeat\]/.test(lastUser(b)) && b.messages.length > 2);
    assert.ok(beatBody, "the late heartbeat reached the brain");
    assert.ok(beatBody.messages.length <= 13, `heartbeat sent ${beatBody.messages.length} messages`);
    const fullBody = parsed.find((b) => /are you there/.test(lastUser(b)));
    assert.ok(fullBody.messages.length > 13, "an operator turn still sends the whole window");

    assert.equal(got.creditErrors.length, 1);
    assert.match(got.creditErrors[0], /out of credit/, "a 402 is explained in plain words, not raw JSON");
    assert.doesNotMatch(got.creditErrors[0], /\{"error"/);

    assert.equal(got.midTurnBeat, null);
    assert.equal(got.midTurnErrors, 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop means stop: a stopped turn never touches the next turn's history or busy flag", { timeout: 90_000 }, async () => {
  // Reproduced by review on 24 Oct: cancelTurn nulled the shared controller,
  // so the stopped turn read the NEXT turn's signal, and on its way out
  // truncated history under it (the operator's new message vanished) and
  // cleared busy while it still ran. Fake brain: requests whose last message
  // contains SLOW wait 1.5 s; everything else answers at once.
  const http = await import("node:http");
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests++;
      const msgs = JSON.parse(body).messages;
      const last = String(msgs[msgs.length - 1]?.content ?? "");
      const send = (text: string) => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      };
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.role === "tool") return send("late reply");
      if (/SLOW/.test(last)) {
        // Ask for a tool; the probe's approval card then sits for 1.5 s.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const call = { index: 0, id: "t1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "echo slow" }) } };
        return res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      }
      send("reply to " + last.replace(/^\[\d\d:\d\d\] /, ""));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-stop-"));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "claw.config.json"), "utf-8"));
    cfg.brains = { default: "fake", heartbeat: "fake", fallbacks: ["fake"],
      catalog: [{ id: "fake", label: "Fake", provider: "openai", model: "fake", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "FAKE_BRAIN_KEY", thinking: false, price: { in: 0, out: 0 } }] };
    cfg.routing = { ...cfg.routing, trustedBrains: ["fake"], cheapBrain: "fake", capableBrain: "fake" };
    for (const k of ["heartbeat", "telegram", "discord", "mcp"]) cfg[k] = { ...(cfg[k] ?? {}), enabled: false };
    const cfgPath = path.join(dir, "stop.json");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const probe = path.join(dir, "probe.mjs");
    fs.writeFileSync(probe, `
      const m = await import(${JSON.stringify(path.join(ROOT, "src/agent.ts"))});
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // The operator presses stop while an approval card is still up.
      const events = { emit() {}, requestApproval: async () => { await sleep(1500); return true; } };
      const texts = () => m.getHistory().map((h) => typeof h.content === "string" ? h.content : (h.content.find?.((b) => b.type === "text")?.text ?? ""));
      const out = {};
      // A user turn, stopped mid-request, then the next message at once.
      const first = m.runTurn("SLOW first", events);
      await sleep(400);
      out.cancelled = m.cancelTurn("operator asked to stop");
      const second = await m.runTurn("second", events);
      out.first = await first;
      out.second = second;
      await sleep(1700);
      out.afterUser = texts();
      out.busyAfterUser = m.turnInFlight().busy;
      // The same with a heartbeat.
      const beat = m.runTurn("[heartbeat] SLOW", events, { kind: "heartbeat" });
      await sleep(400);
      m.cancelTurn("operator asked to stop");
      await m.runTurn("hello there", events);
      await beat;
      await sleep(1700);
      out.afterBeat = texts();
      console.log(JSON.stringify(out));
      process.exit(0);
    `);
    const { stdout } = await execFileAsync("npx", ["tsx", probe], { cwd: ROOT, timeout: 80_000,
      env: { ...process.env, CLAW_DATA_DIR: path.join(dir, "data"), CLAW_CONFIG: cfgPath } });
    const got = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");
    assert.equal(got.cancelled, true);
    assert.equal(got.first, null, "the stopped turn ends quietly");
    assert.equal(got.second, "reply to second");
    assert.ok(got.afterUser.some((t: string) => /second$/.test(t)), "the operator's next message survives");
    assert.ok(got.afterUser.includes("reply to second"));
    assert.equal(got.afterUser.includes("late reply"), false, "nothing from the stopped turn lands later");
    assert.equal(got.afterUser.some((t: string) => /slow/.test(t)), false, "no stray tool result from the stopped turn");
    assert.equal(got.busyAfterUser, false);
    assert.ok(got.afterBeat.some((t: string) => /hello there$/.test(t)), "a stopped heartbeat does not eat the next message");
    assert.ok(got.afterBeat.includes("reply to hello there"));
    assert.equal(got.afterBeat.some((t: string) => /heartbeat/.test(t)), false, "the stopped heartbeat leaves nothing");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
