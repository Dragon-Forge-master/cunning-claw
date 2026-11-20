import assert from "node:assert/strict";
import test from "node:test";
import { addSnippet, connectorGuide, findConnectors, keysNeeded, signInKind } from "./connector-guide.js";
import { MCP_CATALOGUE, catalogueById } from "./mcp-catalog.js";

const byId = (id: string) => {
  const c = catalogueById(id);
  assert.ok(c, `${id} missing from the catalogue`);
  return c!;
};

test("each sign-in kind is read from the catalogue entry, not guessed", () => {
  assert.equal(signInKind(byId("canva")), "browser");
  assert.equal(signInKind(byId("github")), "token");
  assert.equal(signInKind(byId("xero")), "local-keys");
  assert.equal(signInKind(byId("uwchben")), "local");
  assert.deepEqual(keysNeeded(byId("github")), ["GITHUB_TOKEN"]);
  assert.deepEqual(keysNeeded(byId("xero")).sort(), ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"]);
});

test("a browser connector's guide sends the operator to sign in, never to make a key", () => {
  const g = connectorGuide("canva", []);
  assert.match(g, /CONNECTOR GUIDE — Canva \(canva\)/);
  assert.match(g, /Not added on this machine yet/);
  assert.match(g, /vendor's own sign-in page/);
  assert.doesNotMatch(g, /KEYS page as/);
  assert.match(g, /Teach the claw/);
});

test("a token connector's guide names the key and keeps it out of the chat", () => {
  const g = connectorGuide("GitHub", [{ id: "github", status: "needs_auth", tools: 0 }]);
  assert.match(g, /KEYS page as GITHUB_TOKEN/);
  assert.match(g, /Never paste a key into the chat/);
  assert.match(g, /missing or refused/);
  assert.match(g, /github\.com\/settings\/personal-access-tokens/);
});

test("the mcp_add snippet is the catalogue's own entry, address included", () => {
  for (const id of ["canva", "github", "xero"]) {
    const c = byId(id);
    const parsed = JSON.parse(addSnippet(c));
    assert.deepEqual(parsed.mcpServers[id], c.entry);
    assert.ok(connectorGuide(id, []).includes(addSnippet(c)));
  }
});

test("live status is reported as it is", () => {
  assert.match(connectorGuide("notion", [{ id: "notion", status: "connected", tools: 12 }]), /Connected, with 12 tools\./);
});

test("searching by job finds the connectors for it; nothing invents a match", () => {
  assert.ok(findConnectors("invoices").some((c) => c.id === "xero"));
  assert.ok(findConnectors("money").length >= 3);
  const many = connectorGuide("money", []);
  assert.match(many, /connectors match "money"/);
  assert.match(connectorGuide("definitely-not-a-vendor", []), /nothing in the catalogue matches/);
  assert.match(connectorGuide("definitely-not-a-vendor", []), /never guess one/);
});

test("with no query it lists the whole catalogue by category and says what is connected", () => {
  const g = connectorGuide(undefined, [{ id: "canva", status: "connected", tools: 4 }]);
  assert.match(g, new RegExp(`${MCP_CATALOGUE.length} connectors in the catalogue`));
  assert.match(g, /Connected here: canva/);
  for (const c of MCP_CATALOGUE.filter((x) => x.popular)) assert.ok(g.includes(c.label), `${c.label} missing`);
});

test("asked about Outlook, the guide answers about the mailbox — not 'nothing in the catalogue'", () => {
  // "How do I connect Outlook?" used to be told it might work as a custom MCP
  // server, when the answer is one sign-in in the claw's own Chrome.
  const facts = { configured: "Gmail (mail.google.com)", provider: "gmail" as const, profileDir: "~/.config/cunningclaw/chrome" };
  for (const q of ["outlook", "Office 365", "my hotmail", "Microsoft 365 email"]) {
    const g = connectorGuide(q, [], undefined, facts);
    assert.match(g, /^MAIL GUIDE — Outlook on the web/, q);
    assert.match(g, /no key to make and no app to register/);
    assert.match(g, /"email": \{ "provider": "outlook", "outlook": "work" \}/, "Gmail is configured, so it says how to choose Outlook");
    assert.match(g, /profile ~\/\.config\/cunningclaw\/chrome/);
    assert.match(g, /Sending always stops for your approval, and so does delete/);
  }
  const chosen = connectorGuide("outlook", [], undefined, { ...facts, configured: "Outlook on the web — work", provider: "outlook" });
  assert.doesNotMatch(chosen, /Choose Outlook once/, "already chosen: straight to signing in");
  assert.match(chosen, /^1\. Sign in once/m);
  assert.match(connectorGuide("gmail", [], undefined, facts), /^MAIL GUIDE — Gmail/);
  assert.match(connectorGuide(undefined, []), /Email \(Gmail or Outlook\) is not a connector/);
});

test("the same state gives the same text, so the loop guard can still see a repeat", () => {
  const s = [{ id: "slack", status: "connected", tools: 3 }];
  assert.equal(connectorGuide("slack", s), connectorGuide("slack", s));
});
