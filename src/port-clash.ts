import type { Request, Response as ExpressResponse } from "express";

/**
 * What to say when the port is taken.
 *
 * Found by the founder, 20 Nov: he downloaded the v0.5.1 AppImage while his
 * git install ran as a systemd service, double-clicked it, and "it didn't
 * seem to do anything". From a terminal it said "Something is already
 * running on port 3900 — opening it. If that is not Cunning Claw, change
 * server.port". It *was* Cunning Claw, his own, and the line made him guess.
 * So before saying anything the port is asked who it is: a claw answers
 * IDENTITY_PATH with its name and version, and one from before that route
 * existed is still known by its setup page's title. Then the words say
 * plainly which case this is, and what to do if he wanted this copy instead.
 *
 * A leaf: fetch is a parameter, so every case is tested without a second
 * claw on the port.
 */

/** Answers without a session, but only to a name the host gate lets through (src/pocket-host.ts). */
export const IDENTITY_PATH = "/cunningclaw.json";

/**
 * What a claw says about itself to anyone on this machine: that it is
 * Cunning Claw, and which version. Nothing else — no owner's name, no port
 * list, no brain — because no session is asked for. A web page cannot read
 * it either: there is no CORS header, so a cross-origin fetch gets an opaque
 * response, and a rebinding page's own name is refused by the host gate
 * before this runs.
 */
export function clawIdentity(version: string): { app: "cunning-claw"; version: string } {
  return { app: "cunning-claw", version };
}

export function identityRoute(version: string) {
  return (_req: Request, res: ExpressResponse): void => {
    res.set("Cache-Control", "no-store");
    res.json(clawIdentity(version));
  };
}

export type Occupant =
  /** version is null for a claw from before IDENTITY_PATH, which is older than this one by construction. */
  | { kind: "claw"; version: string | null }
  | { kind: "other" };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A version string as a claw would report it; anything else is not trusted onto the screen. */
function cleanVersion(v: unknown): string | null {
  return typeof v === "string" && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24}$/.test(v) ? v : null;
}

/**
 * Who is listening at `base` (http://127.0.0.1:3900). Short timeouts: this
 * runs while someone waits for a double-click to do something.
 */
export async function probePort(base: string, fetchImpl: FetchLike = fetch, timeoutMs = 1500): Promise<Occupant> {
  const get = async (p: string) => {
    try {
      const res = await fetchImpl(base + p, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      return res.ok ? (await res.text()).slice(0, 64 * 1024) : null;
    } catch {
      return null;
    }
  };
  const said = await get(IDENTITY_PATH);
  if (said !== null) {
    try {
      const j = JSON.parse(said);
      if (j && j.app === "cunning-claw") return { kind: "claw", version: cleanVersion(j.version) };
    } catch { /* not ours; ask the setup page */ }
  }
  // Every claw up to v0.5.1 serves this page, under this title, to loopback.
  const page = await get("/welcome");
  if (page !== null && /<title>[^<]*Cunning Claw[^<]*<\/title>/i.test(page)) return { kind: "claw", version: null };
  return { kind: "other" };
}

/** -1, 0 or 1; pre-release and build suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** How to see what holds a port, in the system's own words. */
function whoHolds(port: number, platform: NodeJS.Platform): string {
  if (platform === "win32") return `netstat -ano | findstr :${port}`;
  if (platform === "darwin") return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
  return `ss -ltnp 'sport = :${port}'`;
}

/**
 * The lines to print. `opened` says whether this copy has just opened the
 * running claw in the browser (it does when started by double-click, with
 * CLAW_OPEN_HUD); from a terminal it only says where the running one is.
 */
export function portClashMessage(o: {
  occupant: Occupant;
  port: number;
  url: string;
  ourVersion: string;
  platform: NodeJS.Platform;
  /** As the owner should see it: ~ for home. */
  configFile: string;
  opened: boolean;
}): string[] {
  const { occupant, port, ourVersion, platform } = o;
  if (occupant.kind === "other") {
    return [
      `Something else is using port ${port}, so Cunning Claw cannot start.`,
      `To give him another port, set "port" under "server" in ${o.configFile} (${port + 1}, say) and start him again —`,
      `or stop whatever is using it (${whoHolds(port, platform)} shows what it is).`,
    ];
  }
  const v = occupant.version ? ` (v${occupant.version})` : "";
  const lines = [
    o.opened
      ? `Cunning Claw is already running on this computer${v}, so I've opened that one instead of starting a second copy.`
      : `Cunning Claw is already running on this computer${v}, at ${o.url} — so this copy has not started a second one.`,
  ];
  const cmp = occupant.version ? compareVersions(occupant.version, ourVersion) : -1;
  if (cmp < 0) {
    // His case: a service started at login, and a newer download beside it.
    const stop = platform === "linux"
      ? "stop the other first (systemctl --user stop cunningclaw, if it runs as a service; otherwise close its window)"
      : "close the other one's window first";
    lines.push(
      `${occupant.version ? "That one" : "That one does not say its version, so it"} is older than this copy (v${ourVersion}). To use this one instead, ${stop}, then start this again.`,
    );
  }
  return lines;
}
