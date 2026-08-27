import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MCP_CATALOGUE, catalogueById } from "./mcp-catalog.js";
import { connectorSnapshot } from "./connectors.js";
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
  assert.ok(MCP_CATALOGUE.filter((c) => c.popular).length >= 4);
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
});
