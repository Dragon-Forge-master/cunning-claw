import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MCP_CATALOGUE, catalogueById } from "./mcp-catalog.js";
import { connectorSnapshot, outcome } from "./connectors.js";
import {
  parseMcpServersBlock,
  readUserMcpServers,
  removeUserMcpServer,
  upsertUserMcpServer,
} from "./mcp-config.js";

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
  assert.equal(catalogueById("v0")?.entry.url, "https://mcp.v0.dev/");
  assert.equal(catalogueById("magic-patterns")?.entry.url, "https://mcp.magicpatterns.com/mcp");
  assert.equal(catalogueById("convex")?.entry.url, "https://mcp.convex.dev/mcp");
  assert.equal(catalogueById("railway")?.entry.url, "https://mcp.railway.com/mcp");
  assert.equal(catalogueById("render")?.entry.url, "https://mcp.render.com/mcp");
  for (const id of ["bolt", "replit", "framer", "builder-io"]) {
    assert.equal(catalogueById(id), undefined, `${id} has no working MCP endpoint`);
  }
});
