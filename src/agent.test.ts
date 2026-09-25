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
  ];
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
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

    assert.equal(requests, 5, "an empty answer with no tools gets two continuation checks, like one after tools");
    assert.equal(got.silentNotices.length, 1, "a reply that never comes is said out loud, not left as silence");

    assert.equal(got.errors.length, 1);
    const texts = got.history.map((h: { text: string }) => h.text);
    assert.ok(texts.some((t: string) => /try this$/.test(t)), "the operator's words survive a failed turn");
    assert.match(got.history[got.history.length - 1].text, /^\[This turn failed before a reply: .*418/);
    assert.equal(texts.some((t: string) => /Continuation check/.test(t)), true, "the nudges are real turns in history");

    const journal = fs.readdirSync(path.join(dir, "data", "journal")).map((f) => fs.readFileSync(path.join(dir, "data", "journal", f), "utf-8")).join("");
    assert.match(journal, /no reply/);
    assert.match(journal, /turn failed: .*418/);
    assert.doesNotMatch(journal, /HEARTBEAT/, "quiet beats stay out of the journal as before");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
