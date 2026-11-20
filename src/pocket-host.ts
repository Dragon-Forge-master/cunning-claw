import type { NextFunction, Request, Response } from "express";

/**
 * Which name was this request sent to, and what may it see?
 *
 * The claw binds to 127.0.0.1 and that does not change. But a loopback bind
 * was the only thing standing between the HUD and a DNS-rebinding page: such
 * a page reaches 127.0.0.1 under its own name, and `GET /` hands out the
 * session cookie to whoever asks — the browser stores it for the attacker's
 * name and sends it back, and the Origin check passes because Origin and Host
 * agree. So every request now names a host this claw answers to, or it is
 * refused before any route runs.
 *
 * Three answers:
 *   local   — a loopback name, and no proxy in the way. The whole HUD.
 *   pocket  — a name the operator listed for Pocket Claw (their tailnet name,
 *             e.g. claw-desk.tail1a2b3c.ts.net). /pocket/ and nothing else:
 *             the HUD's master session is never issued to the tailnet.
 *   refused — anything else, including a loopback Host that came through a
 *             proxy. `tailscale serve` passes the client's Host header on
 *             unchanged (ipn/ipnlocal/serve.go: r.Out.Host = r.In.Host) and
 *             always adds X-Forwarded-Host and X-Forwarded-For, so a tailnet
 *             device that sends "Host: 127.0.0.1" is still seen as remote.
 *
 * A leaf: config is passed in, so server.ts and the doctor can both use it.
 */

export type HostVerdict =
  | { kind: "local" }
  | { kind: "pocket"; host: string; origin: string }
  | { kind: "refused"; reason: string };

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** Set by tailscale serve, cloudflared, nginx and friends. Their presence means "not from this machine". */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip", "tailscale-user-login"];

export function splitHost(header: string): { name: string; port: string } | null {
  const h = header.trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(h);
  if (v6) return { name: v6[1], port: v6[2] ?? "" };
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h);
  return m ? { name: m[1], port: m[2] ?? "" } : null;
}

/**
 * A Pocket host as the operator typed it, or null. DNS names only, with an
 * optional port: no IP literals (a tailnet IP would make the WebAuthn origin
 * an IP, which browsers refuse) and never a loopback name, which already
 * means "the HUD".
 */
export function normalisePocketHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = splitHost(raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""));
  if (!parts) return null;
  const { name, port } = parts;
  if (name.length > 253 || !name.includes(".") || LOOPBACK_NAMES.has(name)) return null;
  const labels = name.split(".");
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (labels.every((l) => /^\d+$/.test(l))) return null; // an IPv4 literal
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return port ? `${name}:${port}` : name;
}

/**
 * The origin a phone's browser reports for a Pocket host. HTTPS always —
 * `tailscale serve` terminates TLS with a real certificate — except names
 * under .localhost, which browsers resolve to this machine and treat as a
 * secure context; that exception exists so the end-to-end test can run
 * without a tailnet.
 */
export function pocketOrigin(host: string): string {
  const name = splitHost(host)?.name ?? host;
  return name.endsWith(".localhost") ? `http://${host}` : `https://${host}`;
}

/** The WebAuthn relying-party id: the host without its port. */
export function pocketRpId(host: string): string {
  return splitHost(host)?.name ?? host;
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : undefined;
}

function matchPocket(hostHeader: string, pocketHosts: readonly string[]): string | null {
  const parts = splitHost(hostHeader);
  if (!parts) return null;
  const full = parts.port ? `${parts.name}:${parts.port}` : parts.name;
  for (const h of pocketHosts) {
    if (h === full) return h;
    // A listed name without a port also answers on the default HTTPS port.
    if (!h.includes(":") && h === parts.name && (parts.port === "" || parts.port === "443")) return h;
  }
  return null;
}

export function classifyRequest(
  headers: Record<string, unknown>,
  opts: { bindHost: string; pocketHosts: readonly string[] },
): HostVerdict {
  const hostHeader = header(headers, "host");
  if (!hostHeader) return { kind: "refused", reason: "no Host header" };
  const parts = splitHost(hostHeader);
  if (!parts) return { kind: "refused", reason: "malformed Host header" };
  const proxied = PROXY_HEADERS.some((h) => header(headers, h) !== undefined);
  const bind = opts.bindHost.toLowerCase().replace(/^\[|\]$/g, "");
  const bindIsName = bind !== "" && bind !== "0.0.0.0" && bind !== "::";
  if (!proxied && (LOOPBACK_NAMES.has(parts.name) || (bindIsName && parts.name === bind))) return { kind: "local" };
  const pocket = matchPocket(hostHeader, opts.pocketHosts);
  if (pocket) {
    // A proxy that names a different host than the one we were sent to is
    // either misconfigured or being played with; neither gets an answer.
    const fwd = header(headers, "x-forwarded-host");
    if (fwd !== undefined && matchPocket(fwd.split(",")[0].trim(), opts.pocketHosts) !== pocket) {
      return { kind: "refused", reason: "X-Forwarded-Host disagrees with Host" };
    }
    return { kind: "pocket", host: pocket, origin: pocketOrigin(pocket) };
  }
  if (proxied && LOOPBACK_NAMES.has(parts.name)) return { kind: "refused", reason: "a loopback name arrived through a proxy" };
  return { kind: "refused", reason: `${parts.name} is not a name this claw answers to` };
}

export function pocketPathAllowed(p: string): boolean {
  return p === "/pocket" || p.startsWith("/pocket/");
}

/**
 * The first middleware on the app. Local requests carry on to the HUD;
 * Pocket requests are fenced into /pocket/ with the verdict on res.locals;
 * everything else is refused here, before any route can issue a session.
 */
export function hostGate(opts: () => { bindHost: string; pocketHosts: readonly string[] }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const v = classifyRequest(req.headers as Record<string, unknown>, opts());
    if (v.kind === "refused") {
      // 421 Misdirected Request: "this server does not answer for that name".
      res.status(421).type("text/plain").send("This claw does not answer to that name.\n");
      return;
    }
    if (v.kind === "pocket") {
      if (req.path === "/") {
        res.redirect(302, "/pocket/");
        return;
      }
      if (!pocketPathAllowed(req.path)) {
        res.status(404).json({ error: "Only Pocket Claw is served on this address." });
        return;
      }
      res.locals.pocket = { host: v.host, origin: v.origin };
    }
    next();
  };
}

/** One doctor line. Informational: Pocket is optional and a missing Tailscale is not a fault. */
export function pocketDoctorLine(hasTailscale: boolean, hosts: readonly string[]): { status: "ok" | "warn"; text: string } {
  if (hosts.length && hasTailscale) return { status: "ok", text: `Pocket Claw: answering on ${hosts.join(", ")}` };
  if (hosts.length) return { status: "ok", text: `Pocket Claw: answering on ${hosts.join(", ")} (no tailscale on this machine — another proxy is in front, see docs/POCKET-CLAW.md)` };
  if (hasTailscale) return { status: "ok", text: "Pocket Claw: off — Tailscale is here; press POCKET in the HUD to pair a phone" };
  return {
    status: "warn",
    text: "Pocket Claw: tailscale not found — only needed to reach the claw from your phone. Install it from https://tailscale.com/download (docs/POCKET-CLAW.md)",
  };
}
