/**
 * Remote MCP OAuth the way Claude Code does it for Canva / Notion / Figma:
 * 401 → protected-resource metadata (RFC 9728) → authorization-server
 * metadata (RFC 8414) → Dynamic Client Registration if needed → PKCE in
 * the browser → token. Resource indicator (RFC 8707) goes on the token
 * request so the access token is audience-bound to the MCP URL.
 *
 * Tokens live in data/mcp-oauth.json (gitignored). Never in the transcript.
 *
 * Canva prefers CIMD (a hosted client_id URL). This process is a native
 * loopback app, so we use DCR + PKCE like the MCP spec's local-client
 * profile. If a vendor allowlists only Claude/ChatGPT, stdio via
 * `npx mcp-remote` is the fallback — see docs/mcp.example.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { DATA_DIR } from "./config.js";

const PROTOCOL = "2025-03-26";
const TOKEN_FILE = () => pathJoin(DATA_DIR, "mcp-oauth.json");

function pathJoin(a: string, b: string): string {
  return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "");
}

export type McpToken = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
  client_id?: string;
  token_endpoint?: string;
  resource?: string;
};

type Store = Record<string, McpToken>;

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE(), "utf-8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function tokenFor(serverId: string): McpToken | null {
  const t = readStore()[serverId];
  if (!t?.access_token) return null;
  return t;
}

export function saveToken(serverId: string, token: McpToken): void {
  const store = readStore();
  store[serverId] = token;
  writeStore(store);
}

/** RFC 9728 / RFC 8414: insert `/.well-known/<name>` between host and path. */
export function wellKnownUrls(resourceUrl: string, name: string): string[] {
  try {
    const u = new URL(resourceUrl);
    const path = u.pathname.replace(/\/+$/, "");
    return [...new Set([
      `${u.origin}/.well-known/${name}${path}`,
      `${u.origin}/.well-known/${name}`,
    ])];
  } catch {
    return [];
  }
}

export function parseResourceMetadataUrl(wwwAuthenticate: string | null, mcpUrl: string): string | null {
  const header = wwwAuthenticate ?? "";
  const m = header.match(/resource_metadata=(?:"([^"]+)"|([^\s,]+))/i);
  if (m) return m[1] || m[2];
  return wellKnownUrls(mcpUrl, "oauth-protected-resource")[0] ?? null;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "MCP-Protocol-Version": PROTOCOL, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OAuth discovery HTTP ${res.status} at ${url}`);
  return await res.json();
}

async function firstJson(urls: string[]): Promise<any | null> {
  for (const url of urls) {
    try {
      return await getJson(url);
    } catch {
      continue;
    }
  }
  return null;
}

function openBrowser(url: string): void {
  const plat = process.platform;
  // cmd's `start` splits on every & in the URL — an OAuth authorization URL
  // is made of &s, so Windows opened a truncated sign-in page and the flow
  // timed out after three minutes, every time. rundll32 takes the URL whole.
  const child =
    plat === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : plat === "win32"
        ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.once("error", () => { /* reported by the timeout path, not a crash */ });
  child.unref();
}

/**
 * Does the callback's state match the one we sent?
 *
 * The old guard read `if (parsed.state && parsed.state !== state) throw` — so a
 * callback that simply OMITTED the parameter skipped the check altogether, and
 * anything able to reach the loopback listener could inject its own
 * authorization code and have the claw store the attacker's tokens. Absent
 * state is a mismatch, not an exemption.
 *
 * Plain `===` is right here: state is 128 bits of randomBytes compared once, so
 * timing is not the threat model that matters.
 */
export function callbackStateOk(expected: string, received: string | null | undefined): boolean {
  return typeof received === "string" && received.length > 0 && received === expected;
}

function waitForCode(portHint = 0): Promise<{ port: number; code: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://127.0.0.1`);
        const err = u.searchParams.get("error");
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state") ?? "";
        // Only a genuine callback settles this listener. It used to resolve on
        // the FIRST request of any path, so a browser asking for /favicon.ico
        // could win the race and settle the sign-in with an empty code — and
        // now that the state check is strict (below), an empty state is a hard
        // refusal rather than a skipped check. Anything that is not the
        // callback gets a 404 and the listener keeps waiting.
        if (u.pathname !== "/callback" || (!code && !err)) {
          res.writeHead(404);
          res.end("not the OAuth callback");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (err) {
          res.end(`<p>Cunning Claw could not finish sign-in (${err}). You can close this tab.</p>`);
          (server as any)._fail?.(new Error(err));
        } else {
          res.end("<p>Signed in. You can close this tab and return to Cunning Claw.</p>");
          (server as any)._ok?.(code ?? "", state);
        }
      } catch (e: any) {
        res.writeHead(400);
        res.end("bad callback");
        (server as any)._fail?.(e);
      }
    });
    server.listen(portHint, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const code = new Promise<string>((ok, fail) => {
        let timer: NodeJS.Timeout;
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          server.close();
          fn();
        };
        (server as any)._ok = (c: string, state: string) => {
          finish(() => ok(JSON.stringify({ code: c, state })));
        };
        (server as any)._fail = (e: Error) => {
          finish(() => fail(e));
        };
        timer = setTimeout(() => {
          finish(() => fail(new Error("OAuth timed out — finish sign-in in the browser within three minutes.")));
        }, 180_000);
      });
      // A late timeout must not become an unhandled rejection when the caller
      // has already given up and moved on; real awaiters still see it.
      code.catch(() => {});
      resolve({ port, code });
    });
    server.on("error", reject);
  });
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": PROTOCOL },
    body: JSON.stringify({
      client_name: "Cunning Claw",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(
      `Dynamic client registration failed (HTTP ${res.status}). ` +
      `If this is Canva, they may only allowlist Claude/ChatGPT — use the mcp-remote stdio snippet in docs/mcp.example.json.`,
    );
  }
  const body = await res.json() as { client_id?: string };
  if (!body.client_id) throw new Error("OAuth server did not return a client_id.");
  return body.client_id;
}

export async function refreshIfNeeded(serverId: string, token: McpToken): Promise<McpToken> {
  if (!token.refresh_token || !token.token_endpoint) return token;
  if (token.expires_at && token.expires_at > Date.now() + 60_000) return token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  });
  if (token.client_id) body.set("client_id", token.client_id);
  if (token.resource) body.set("resource", token.resource);
  const res = await fetch(token.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return token;
  const json = await res.json() as any;
  const next: McpToken = {
    ...token,
    access_token: json.access_token ?? token.access_token,
    refresh_token: json.refresh_token ?? token.refresh_token,
    expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : token.expires_at,
  };
  saveToken(serverId, next);
  return next;
}

function looksLikeAsMeta(j: any): boolean {
  return Boolean(j && typeof j.authorization_endpoint === "string" && typeof j.token_endpoint === "string");
}

function defaultAsMeta(origin: string): any {
  return {
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
  };
}

/**
 * Full browser OAuth for one remote MCP URL. Returns a bearer token or throws.
 * Does not run at boot — systemd has no browser. Call from mcp_login.
 */
export async function authorizeMcp(
  serverId: string,
  mcpUrl: string,
  wwwAuthenticate: string | null,
  log: (line: string) => void = () => {},
): Promise<McpToken> {
  const resourceParam = mcpUrl.split("?")[0];
  const headerMeta = parseResourceMetadataUrl(wwwAuthenticate, mcpUrl);
  const resource = await firstJson([
    ...(headerMeta ? [headerMeta] : []),
    ...wellKnownUrls(mcpUrl, "oauth-protected-resource"),
  ]);

  const origin = new URL(mcpUrl).origin;
  let asMeta: any = null;
  if (looksLikeAsMeta(resource)) {
    asMeta = resource;
  } else {
    const asList: string[] = resource?.authorization_servers ?? [];
    const asUrl = asList[0] ?? resource?.authorization_server ?? resource?.issuer ?? origin;
    asMeta = await firstJson(wellKnownUrls(String(asUrl), "oauth-authorization-server"));
    if (!asMeta) asMeta = await firstJson(wellKnownUrls(origin, "oauth-authorization-server"));
  }
  if (!looksLikeAsMeta(asMeta)) asMeta = defaultAsMeta(origin);

  const authz = asMeta.authorization_endpoint as string;
  const tokenEp = asMeta.token_endpoint as string;

  const { port, code: codeP } = await waitForCode(0);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  let clientId = asMeta.client_id as string | undefined;
  if (!clientId && asMeta.registration_endpoint) {
    clientId = await registerClient(String(asMeta.registration_endpoint), redirectUri);
  }
  if (!clientId) {
    throw new Error(
      "No client_id and no dynamic registration. Put a Bearer token in headers, or use the mcp-remote stdio snippet in docs/mcp.example.json.",
    );
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const authUrl = new URL(authz);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  const scopes: string[] = resource?.scopes_supported ?? asMeta.scopes_supported ?? [];
  if (Array.isArray(scopes) && scopes.length) authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("resource", resourceParam);

  /**
   * Say the URL out loud before opening it.
   *
   * openBrowser is fire-and-forget: xdg-open with no desktop session, a Windows
   * install with no default browser, a headless or SSH login — all fail
   * silently, and the flow then blocked for three minutes with the operator
   * given nothing to act on. The authorization URL is the whole flow; if it is
   * only ever passed to a process that may not exist, sign-in is unfinishable.
   */
  log(`Sign in to ${serverId}: ${authUrl.toString()}`);
  log(`Waiting up to 3 minutes for the callback. If no browser opened, paste that link into one.`);
  openBrowser(authUrl.toString());
  const raw = await codeP;
  const parsed = JSON.parse(raw) as { code: string; state: string };
  if (!callbackStateOk(state, parsed.state)) {
    throw new Error("OAuth state mismatch — refusing the callback.");
  }
  if (!parsed.code) throw new Error("OAuth callback had no code.");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: parsed.code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: resourceParam,
  });
  const res = await fetch(tokenEp, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}).`);
  const json = await res.json() as any;
  const token: McpToken = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type,
    expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
    client_id: clientId,
    token_endpoint: tokenEp,
    resource: resourceParam,
  };
  if (!token.access_token) throw new Error("Token endpoint returned no access_token.");
  saveToken(serverId, token);
  return token;
}
