// Llygad — the claw's eye on the local network. "Llygad" is Welsh for eye.
//
// An unprivileged presence radar: ping the /24 to wake the neighbour table,
// then read `ip neigh` for who answered. No raw sockets, no nmap, no root —
// and nothing leaves the LAN. Names come from senses/devices.json, a file the
// operator writes by hand (see devices.example.json); an unnamed MAC is
// reported as a count, never invented.
//
// MCP stdio server — run as `node senses/llygad.mjs`. Spawned by the claw
// with cwd = repo root (src/mcp.ts), so relative paths resolve.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import {
  errorResult,
  readJsonSafe,
  runCommand,
  sensesDataDir,
  serve,
  textResult,
} from "./lib.mjs";

/**
 * The machine's own /24, from the default route's `src` address. Falls back
 * to any `src` in the table when the default line carries none (some DHCP
 * setups), and to null when the box has no route at all.
 */
export function deriveSubnet(ipRouteOutput) {
  const lines = String(ipRouteOutput ?? "").split("\n");
  const grab = (line) => line.match(/\bsrc (\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/)?.[1] ?? null;
  for (const line of lines) {
    if (line.startsWith("default")) {
      const hit = grab(line);
      if (hit) return hit;
    }
  }
  for (const line of lines) {
    const hit = grab(line);
    if (hit) return hit;
  }
  return null;
}

/** Three dotted octets, each 0–255 — the only shape we will ping. */
export function validSubnet(s) {
  const m = String(s ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/** All 254 host addresses of a /24. */
export function pingTargets(subnet) {
  const out = [];
  for (let i = 1; i <= 254; i++) out.push(`${subnet}.${i}`);
  return out;
}

/**
 * Parse `ip neigh` for entries with a MAC. Only REACHABLE and STALE count as
 * present — FAILED and INCOMPLETE are the kernel saying nobody answered.
 */
export function parseNeigh(output) {
  const out = [];
  for (const line of String(output ?? "").split("\n")) {
    const m = line.match(
      /^(\d{1,3}(?:\.\d{1,3}){3})\s.*\blladdr\s+([0-9a-fA-F:]{17})\b.*\b(REACHABLE|STALE)\b/,
    );
    if (m) out.push({ ip: m[1], mac: m[2].toLowerCase(), state: m[3] });
  }
  return out;
}

/**
 * Split neighbours into named devices (per the operator's devices.json,
 * matched case-insensitively by MAC) and a count of strangers.
 */
export function mergeNames(entries, names) {
  const lookup = new Map(
    Object.entries(names ?? {}).map(([mac, name]) => [mac.toLowerCase(), String(name)]),
  );
  const named = [];
  let unnamed = 0;
  for (const e of entries) {
    const name = lookup.get(e.mac);
    if (name) named.push({ ...e, name });
    else unnamed++;
  }
  return { named, unnamed };
}

export function formatHomeReport(named, unnamed, subnet) {
  const lines = [];
  if (named.length) {
    lines.push(`Home on ${subnet}.0/24:`);
    for (const d of named) lines.push(`  ${d.name} — ${d.ip} (${d.state.toLowerCase()})`);
  } else {
    lines.push(`No named devices answered on ${subnet}.0/24.`);
  }
  lines.push(
    unnamed === 1 ? "1 unnamed device is also present." : `${unnamed} unnamed devices are also present.`,
  );
  lines.push(
    "Honest note: phones in deep sleep often ignore ping, so an absent device is not proof anyone is out.",
  );
  return lines.join("\n");
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function deviceNames() {
  return readJsonSafe(path.join(HERE, "devices.json")) ?? {};
}

function cacheFile() {
  return path.join(sensesDataDir(), "llygad-last.json");
}

function writeCache(entries) {
  fs.writeFileSync(
    cacheFile(),
    JSON.stringify({ time: new Date().toISOString(), devices: entries }, null, 2),
  );
}

async function currentNeighbours() {
  const neigh = await runCommand("ip", ["neigh"], { timeoutMs: 5000 });
  if (neigh.missing) return { error: "`ip` is not installed — this sense needs iproute2." };
  return { entries: parseNeigh(neigh.stdout) };
}

async function getDevicesHome(args) {
  let subnet = args?.subnet;
  if (subnet !== undefined && !validSubnet(subnet)) {
    return errorResult(`"${String(subnet)}" is not a subnet — expected three octets like "192.168.1".`);
  }
  if (!subnet) {
    const route = await runCommand("ip", ["route"], { timeoutMs: 5000 });
    if (route.missing) return errorResult("`ip` is not installed — this sense needs iproute2.");
    subnet = deriveSubnet(route.stdout);
    if (!subnet) {
      return errorResult("Could not derive the local subnet from `ip route` — pass one, e.g. {\"subnet\":\"192.168.1\"}.");
    }
  }

  // Sweep in batches so 254 pings finish inside ~10 s without forking 254
  // processes at once. -W1 caps each ping at a second; a batch runs in
  // parallel and takes as long as its slowest member.
  const targets = pingTargets(subnet);
  for (let i = 0; i < targets.length; i += 64) {
    await Promise.allSettled(
      targets.slice(i, i + 64).map((ip) => runCommand("ping", ["-c1", "-W1", ip], { timeoutMs: 2500 })),
    );
  }

  const now = await currentNeighbours();
  if (now.error) return errorResult(now.error);
  const { named, unnamed } = mergeNames(now.entries, deviceNames());
  writeCache(now.entries);
  return textResult(formatHomeReport(named, unnamed, subnet));
}

async function getPresenceChange() {
  const cached = readJsonSafe(cacheFile());
  if (!cached?.devices) {
    return textResult("No previous scan to compare against — run get_devices_home first.");
  }
  const now = await currentNeighbours();
  if (now.error) return errorResult(now.error);

  const names = deviceNames();
  const label = (e) => names[e.mac] ?? Object.entries(names).find(([m]) => m.toLowerCase() === e.mac)?.[1] ?? `unnamed device at ${e.ip}`;
  const before = new Set(cached.devices.map((d) => d.mac));
  const after = new Set(now.entries.map((d) => d.mac));
  const appeared = now.entries.filter((d) => !before.has(d.mac));
  const left = cached.devices.filter((d) => !after.has(d.mac));
  writeCache(now.entries);

  const lines = [`Since the last scan (${cached.time ?? "unknown time"}):`];
  for (const d of appeared) lines.push(`  appeared: ${label(d)}`);
  for (const d of left) lines.push(`  left: ${label(d)}`);
  if (!appeared.length && !left.length) lines.push("  no change.");
  lines.push(
    "Based on the kernel neighbour table without a fresh sweep — a sleeping phone can look like a departure.",
  );
  return textResult(lines.join("\n"));
}

export const server = {
  name: "llygad",
  version: "0.1.0",
  tools: [
    {
      name: "get_devices_home",
      description:
        "Unprivileged LAN presence sweep: ping the local /24 (derived from `ip route`, or " +
        "pass subnet like \"192.168.1\"), then read `ip neigh` for devices with MACs. " +
        "Names come from senses/devices.json; strangers are counted, not guessed.",
      inputSchema: {
        type: "object",
        properties: {
          subnet: {
            type: "string",
            description: "First three octets of the network, e.g. \"192.168.1\". Default: derived from ip route.",
          },
        },
      },
      handler: getDevicesHome,
    },
    {
      name: "get_presence_change",
      description:
        "Who appeared or left since the last scan, by comparing the neighbour table against " +
        "the cache in workspace/senses/llygad-last.json.",
      inputSchema: { type: "object", properties: {} },
      handler: getPresenceChange,
    },
  ],
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(server);
}
