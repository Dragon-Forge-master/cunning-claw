// Uwchben — what's overhead. "Uwchben" is Welsh for above.
//
// Two public feeds, no keys: adsb.lol for aircraft near a point, and
// wheretheiss.at for the International Space Station. Read-only GETs; nothing
// about the operator is sent beyond the coordinates they asked about.
//
// MCP stdio server — run as `node senses/uwchben.mjs`. Spawned by the claw
// with cwd = repo root (src/mcp.ts).

import { pathToFileURL } from "node:url";
import { clampNumber, errorResult, serve, textResult } from "./lib.mjs";

// Cardiff — the claw's home town. Stated in the tool description so the
// model knows what "no coordinates" means.
export const DEFAULT_LAT = 51.48;
export const DEFAULT_LON = -3.18;
export const MAX_AIRCRAFT = 15;

/** International nautical mile: exactly 1.852 km. */
export function kmToNm(km) {
  return km / 1.852;
}

export function clampRadiusKm(raw) {
  return clampNumber(raw, 1, 100, 25);
}

/** adsb.lol wants nautical miles in the path; we clamp then convert. */
export function buildAdsbUrl(lat, lon, radiusKm) {
  const nm = Math.max(1, Math.round(kmToNm(clampRadiusKm(radiusKm))));
  return `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`;
}

export function validCoord(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** One plain sentence per aircraft, only claiming fields the feed sent. */
export function describeAircraft(ac) {
  const flight = String(ac?.flight ?? "").trim();
  const bits = [flight ? `Flight ${flight}` : "An aircraft with no callsign"];
  if (ac?.t) bits.push(`a ${ac.t}`);
  const alt = ac?.alt_baro;
  if (alt === "ground") bits.push("on the ground");
  else if (Number.isFinite(Number(alt))) bits.push(`at ${Math.round(Number(alt)).toLocaleString("en-GB")} ft`);
  if (Number.isFinite(Number(ac?.gs))) bits.push(`doing ${Math.round(Number(ac.gs))} kt`);
  if (Number.isFinite(Number(ac?.track))) bits.push(`heading ${Math.round(Number(ac.track))}°`);
  return bits.join(", ") + ".";
}

export function formatOverhead(body, lat, lon, radiusKm) {
  const aircraft = Array.isArray(body?.ac) ? body.ac : [];
  if (!aircraft.length) {
    return `Empty sky — no aircraft reporting within ${radiusKm} km of ${lat}, ${lon}. That is a fine answer.`;
  }
  const shown = aircraft.slice(0, MAX_AIRCRAFT);
  const lines = shown.map(describeAircraft);
  const more = aircraft.length > shown.length ? `\n(${aircraft.length - shown.length} more not listed.)` : "";
  return `${aircraft.length} aircraft within ${radiusKm} km of ${lat}, ${lon}:\n${lines.join("\n")}${more}`;
}

/**
 * A rough "over the South Atlantic" for the ISS — only where a crude
 * bounding box makes it trivially true. The feed has no place names, and a
 * wrong guess is worse than a coordinate, so anywhere ambiguous returns null.
 */
export function roughRegion(lat, lon) {
  if (lat < -60) return "over the Southern Ocean";
  if (lat >= -55 && lat <= -5 && lon >= -30 && lon <= 5) return "over the South Atlantic";
  if (lat >= 25 && lat <= 55 && lon >= -55 && lon <= -20) return "over the North Atlantic";
  if (lat >= -40 && lat <= 5 && lon >= 60 && lon <= 95) return "over the Indian Ocean";
  if (lat >= -45 && lat <= 45 && (lon >= 160 || lon <= -130)) return "over the Pacific";
  return null;
}

export function formatIss(body) {
  const lat = Number(body?.latitude);
  const lon = Number(body?.longitude);
  const alt = Number(body?.altitude);
  const vel = Number(body?.velocity);
  const where = Number.isFinite(lat) && Number.isFinite(lon) ? roughRegion(lat, lon) : null;
  // With no ocean box hit, the coordinates ARE the answer — repeating them
  // twice ("above X, at X") read like a stutter in the first live smoke test.
  const spot = where ? `${where}, at ${lat.toFixed(2)}, ${lon.toFixed(2)}` : `above ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  return (
    `The ISS is ${spot} — altitude ${Math.round(alt)} km, ` +
    `moving at ${Math.round(vel).toLocaleString("en-GB")} km/h.`
  );
}

async function fetchJson(url, apiName) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { error: `${apiName} did not answer: ${err?.message ?? err}` };
  }
  if (!res.ok) return { error: `${apiName} answered HTTP ${res.status}.` };
  try {
    return { body: await res.json() };
  } catch {
    return { error: `${apiName} answered, but not with JSON.` };
  }
}

async function getWhatsOverhead(args) {
  const lat = validCoord(args?.lat, -90, 90, DEFAULT_LAT);
  const lon = validCoord(args?.lon, -180, 180, DEFAULT_LON);
  const radiusKm = clampRadiusKm(args?.radius_km);
  const { body, error } = await fetchJson(buildAdsbUrl(lat, lon, radiusKm), "adsb.lol");
  if (error) return errorResult(error);
  return textResult(formatOverhead(body, lat, lon, radiusKm));
}

async function getIssPosition() {
  const { body, error } = await fetchJson(
    "https://api.wheretheiss.at/v1/satellites/25544",
    "wheretheiss.at",
  );
  if (error) return errorResult(error);
  if (!Number.isFinite(Number(body?.latitude))) {
    return errorResult("wheretheiss.at answered without a position.");
  }
  return textResult(formatIss(body));
}

export const server = {
  name: "uwchben",
  version: "0.1.0",
  tools: [
    {
      name: "get_whats_overhead",
      description:
        "Aircraft currently overhead, from the public adsb.lol feed: callsign, type, altitude, " +
        "speed, heading. Defaults to Cardiff (51.48, -3.18) with a 25 km radius; pass lat/lon " +
        "and radius_km (1–100) to look elsewhere.",
      inputSchema: {
        type: "object",
        properties: {
          lat: { type: "number", description: "Latitude, -90..90. Default 51.48 (Cardiff)." },
          lon: { type: "number", description: "Longitude, -180..180. Default -3.18 (Cardiff)." },
          radius_km: { type: "number", description: "Search radius in km, 1–100 (default 25)." },
        },
      },
      handler: getWhatsOverhead,
    },
    {
      name: "get_iss_position",
      description:
        "Where the International Space Station is right now — position, altitude, velocity — " +
        "from the public wheretheiss.at feed.",
      inputSchema: { type: "object", properties: {} },
      handler: getIssPosition,
    },
  ],
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(server);
}
