import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "./config.js";
import { MCP_CATALOGUE, catalogueById } from "./mcp-catalog.js";
import { connectorSnapshot, loginConnector, outcome, retryConnector } from "./connectors.js";
import {
  parseMcpServersBlock,
  readUserMcpServers,
  removeUserMcpServer,
  upsertUserMcpServer,
} from "./mcp-config.js";

/** Synthetic, per redact.test.ts — nothing resembling a live credential. */
const GH_TOKEN = "ghp_EXAMPLEfake0000111122223333444455";

/** Set (or unset) one env var; returns the undo. */
function setEnv(name: string, value: string | undefined): () => void {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  };
}

/**
 * A sandbox for the login/retry tests: HOME points at an empty temp dir so the
 * operator's real mcp.json / .claude.json / .cursor files are never read or
 * written, and mcp is switched off in the (in-memory) config so no code path
 * can reach a real connect. The token guards under test run before both, so
 * the guarded messages are unchanged; everything past the guard is inert.
 */
async function inConnectorSandbox(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-home-"));
  const undoHome = setEnv("HOME", dir);
  const savedMcp = config.mcp;
  config.mcp = { ...(savedMcp ?? {}), enabled: false } as typeof config.mcp;
  try {
    await fn();
  } finally {
    config.mcp = savedMcp;
    undoHome();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the catalogue uses vendor Streamable HTTP URLs, not invented ones", () => {
  assert.equal(catalogueById("canva")?.entry.url, "https://mcp.canva.com/mcp");
  assert.equal(catalogueById("notion")?.entry.url, "https://mcp.notion.com/mcp");
  assert.equal(catalogueById("figma")?.entry.url, "https://mcp.figma.com/mcp");
  assert.equal(catalogueById("github")?.entry.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(catalogueById("slack")?.entry.url, "https://mcp.slack.com/mcp");
  assert.equal(catalogueById("hubspot")?.entry.url, "https://mcp.hubspot.com/anthropic");
  assert.equal(catalogueById("zapier")?.entry.url, "https://mcp.zapier.com/api/v1/connect");
  assert.equal(catalogueById("square")?.entry.type, "sse");
  assert.equal(catalogueById("xero")?.entry.command, "npx");
  assert.ok(catalogueById("xero")?.entry.args?.some((a) => a.includes("@xeroapi/xero-mcp-server")));
  assert.ok(MCP_CATALOGUE.filter((c) => c.popular).length >= 4);
});

test("the catalogue is a directory people can browse, not five lonely rows", () => {
  assert.ok(MCP_CATALOGUE.length >= 50, `catalogue has ${MCP_CATALOGUE.length} entries`);
  const ids = MCP_CATALOGUE.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "catalogue ids must be unique");
  for (const c of MCP_CATALOGUE) {
    const url = c.entry.url ?? c.entry.httpUrl;
    assert.ok(url || c.entry.command, `${c.id} needs a url or a command`);
    if (url) {
      assert.ok(/^https:\/\//.test(url), `${c.id} URL must be https: ${url}`);
      assert.ok(!url.includes("workers.dev"), `${c.id} looks like a one-off worker, not a vendor host`);
    }
    assert.ok(c.label && c.blurb && c.category, `${c.id} needs label, blurb, category`);
  }
  const names = MCP_CATALOGUE.map((c) => c.label.toLowerCase());
  for (const must of ["slack", "hubspot", "canva", "github", "stripe", "notion", "xero"]) {
    assert.ok(names.includes(must), `people look for ${must} in a connectors list`);
  }
});

test("a pasted Claude Code mcpServers block round-trips into the user file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mcp-"));
  const file = path.join(dir, "mcp.json");
  const parsed = parseMcpServersBlock({
    mcpServers: {
      canva: { type: "http", url: "https://mcp.canva.com/mcp" },
    },
  });
  assert.equal(parsed[0].id, "canva");
  upsertUserMcpServer("canva", { type: "http", url: "https://mcp.canva.com/mcp" }, file);
  const stored = readUserMcpServers(file);
  assert.equal(stored.canva.url, "https://mcp.canva.com/mcp");
  assert.equal(removeUserMcpServer("canva", file), true);
  assert.equal(readUserMcpServers(file).canva, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("connector snapshot lists catalogue entries so the HUD is not an empty JSON file", () => {
  const snap = connectorSnapshot();
  assert.equal(snap.path.endsWith("mcp.json") || snap.path.includes("cunningclaw"), true);
  const canva = snap.connectors.find((c) => c.id === "canva");
  assert.ok(canva, "Canva must appear even before anyone adds it");
  assert.equal(canva?.typeLabel, "Web");
  assert.equal(["not_connected", "connected", "needs_auth", "failed", "disabled"].includes(canva?.status ?? ""), true);
  assert.ok(snap.connectors.find((c) => c.id === "slack"), "Slack must be in the directory");
  assert.ok(snap.connectors.find((c) => c.id === "hubspot"), "HubSpot must be in the directory");
  assert.ok((snap.categories || []).includes("Sales"));
  assert.ok(snap.catalogueSize >= 50);
});

test("a Connect that wrote a file but connected nothing does not claim success", () => {
  // The panel reported "Added canva." for a server that had answered 401 and
  // loaded no tools, so a hosted connector looked like a dead button even when
  // the request had worked. What the operator needs is the connection result.
  const row = (over: Record<string, unknown>) =>
    ({ id: "canva", tools: 0, detail: "", ...over }) as unknown as Parameters<typeof outcome>[1];

  assert.match(outcome("canva", row({ status: "needs_auth" })), /press Reconnect to sign in/);
  assert.doesNotMatch(outcome("canva", row({ status: "needs_auth" })), /^Added canva\.$/);

  const failed = outcome("canva", row({ status: "failed", detail: "HTTP 500" }));
  assert.match(failed, /did not connect/);
  assert.match(failed, /HTTP 500/, "the reason must survive into the message");

  assert.match(outcome("canva", row({ status: "connected", tools: 7 })), /Connected canva — 7 tools\./);
  assert.match(outcome("canva", row({ status: "connected", tools: 1 })), /1 tool\./, "singular, not '1 tools'");
  assert.match(outcome("canva", undefined), /not showing up/);
});

test("catalogue ids are unique, so no entry silently shadows another", () => {
  const ids = MCP_CATALOGUE.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate catalogue ids: ${dupes.join(", ")}`);
});

test("the prompt-to-app builders are in the directory, at their probed URLs", () => {
  // Every URL here answered a real MCP initialize call. Builders that answered
  // with a web page or a 404 (Bolt, Replit, Framer, Builder.io) are left out on
  // purpose — a listed connector that cannot connect is worse than an absent one.
  assert.equal(catalogueById("lovable")?.entry.url, "https://mcp.lovable.dev/mcp");
  // mcp.v0.dev now 307-redirects; v0's docs give v0.app/api/mcp as the address.
  assert.equal(catalogueById("v0")?.entry.url, "https://v0.app/api/mcp");
  assert.equal(catalogueById("magic-patterns")?.entry.url, "https://mcp.magicpatterns.com/mcp");
  assert.equal(catalogueById("convex")?.entry.url, "https://mcp.convex.dev/mcp");
  assert.equal(catalogueById("railway")?.entry.url, "https://mcp.railway.com/mcp");
  assert.equal(catalogueById("render")?.entry.url, "https://mcp.render.com/mcp");
  for (const id of ["bolt", "replit", "framer", "builder-io"]) {
    assert.equal(catalogueById(id), undefined, `${id} has no working MCP endpoint`);
  }
});

test("GitHub is declared token-auth in the catalogue, because its OAuth can never work here", () => {
  // GitHub refuses self-registered OAuth clients, so a browser "Reconnect" is
  // a button that can never succeed. The catalogue must say so.
  const gh = catalogueById("github");
  assert.equal(gh?.tokenEnv, "GITHUB_TOKEN");
  assert.match(gh?.entry.headers?.Authorization ?? "", /\$\{GITHUB_TOKEN\}/);
  // GitHub is the only token-auth vendor today; OAuth-capable entries must not
  // grow a tokenEnv by accident, or their working sign-in gets replaced by a
  // "paste a token" dead end.
  assert.equal(catalogueById("canva")?.tokenEnv, undefined);
  assert.equal(catalogueById("notion")?.tokenEnv, undefined);
});

test("the snapshot's github row says which key it needs and whether it exists yet", () => {
  const github = () => connectorSnapshot().connectors.find((c) => c.id === "github");

  let undo = setEnv("GITHUB_TOKEN", undefined);
  try {
    assert.equal(github()?.tokenEnv, "GITHUB_TOKEN");
    assert.equal(github()?.tokenSet, false, "no env var — the HUD must show the key as missing");
  } finally { undo(); }

  undo = setEnv("GITHUB_TOKEN", "   ");
  try {
    assert.equal(github()?.tokenSet, false, "a blank token is not a token");
  } finally { undo(); }

  undo = setEnv("GITHUB_TOKEN", GH_TOKEN);
  try {
    assert.equal(github()?.tokenSet, true);
  } finally { undo(); }

  // OAuth connectors carry no token fields at all — the HUD keys off presence.
  const canva = connectorSnapshot().connectors.find((c) => c.id === "canva");
  assert.equal(canva?.tokenEnv, undefined);
  assert.equal(canva?.tokenSet, undefined);
});

test("Reconnect on github without a token points at the Keys page instead of attempting OAuth", async () => {
  await inConnectorSandbox(async () => {
    const undo = setEnv("GITHUB_TOKEN", undefined);
    const oauthLog: string[] = [];
    try {
      const res = await loginConnector("github", (line) => oauthLog.push(line));
      assert.equal(res.ok, false);
      assert.match(res.message, /token/i, "the message must say it is token auth");
      assert.match(res.message, /Keys page/, "the fix is on the Keys page — the message must send the operator there");
      assert.match(res.message, /GITHUB_TOKEN/, "name the exact key to paste");
      assert.deepEqual(oauthLog, [], "no OAuth flow may start — that was the button that did nothing");
    } finally { undo(); }
  });
});

test("Connect on github without a token names the missing key and writes nothing", async () => {
  await inConnectorSandbox(async () => {
    const undo = setEnv("GITHUB_TOKEN", undefined);
    try {
      const before = JSON.stringify(readUserMcpServers());
      const res = await retryConnector("github");
      assert.equal(res.ok, false);
      assert.match(res.message, /GITHUB_TOKEN/);
      assert.match(res.message, /Keys page/);
      assert.equal(readUserMcpServers().github, undefined, "a doomed connector must not be written into mcp.json");
      assert.equal(JSON.stringify(readUserMcpServers()), before, "the user file is untouched");
    } finally { undo(); }
  });
});

test("with a GITHUB_TOKEN in the env, Connect stops telling the operator to paste one", async () => {
  await inConnectorSandbox(async () => {
    const undo = setEnv("GITHUB_TOKEN", GH_TOKEN);
    try {
      // The connection itself cannot succeed in a test (mcp is off in the
      // sandbox); what matters is that login falls through to the retry path
      // rather than repeating the "paste a token" dead end.
      const res = await loginConnector("github");
      assert.doesNotMatch(res.message, /paste/i);
      assert.doesNotMatch(res.message, /Keys page/);
    } finally { undo(); }
  });
});
