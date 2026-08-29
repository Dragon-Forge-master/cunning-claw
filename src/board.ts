import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config, DATA_DIR, ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * The Forge Board.
 *
 * Not a status page — a standing answer to "what is the state of everything?",
 * assembled from things that are actually true rather than typed in by hand.
 *
 * Everything slow (GitHub, weather) is cached, because a board you open with
 * coffee must not take nine seconds to draw. Everything that can fail returns a
 * stated absence rather than a blank: an empty panel is indistinguishable from
 * a broken one, and the operator cannot tell which.
 */

interface Cached<T> { at: number; value: T }
const cache = new Map<string, Cached<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const SEP = "|:|";

// ---------------------------------------------------------------------------

export interface Repo {
  name: string;
  pushedAt: string;
  daysAgo: number;
  description: string;
  isPrivate: boolean;
  language: string | null;
}

/**
 * Whose repositories? The configured owner if set — otherwise whoever is
 * actually signed in to gh on THIS machine. The author's own GitHub name was
 * once hardcoded as the fallback, so every fresh install anywhere booted
 * showing his repositories. A butler serves the house he is standing in.
 */
let detectedOwner: string | null | undefined;
async function githubOwner(): Promise<string | null> {
  if (config.board?.githubOwner) return config.board.githubOwner;
  if (detectedOwner !== undefined) return detectedOwner;
  try {
    const { stdout } = await execFileAsync("gh", ["api", "user", "--jq", ".login"], { timeout: 10000 });
    detectedOwner = stdout.trim() || null;
  } catch {
    detectedOwner = null;
  }
  return detectedOwner;
}

/** Your repositories, most recently touched first. Cached — gh is not fast. */
export async function repos(): Promise<{ items: Repo[]; error?: string }> {
  return cached("repos", 15 * 60_000, async () => {
    const owner = await githubOwner();
    if (!owner) {
      return { items: [], error: "no GitHub account — run `gh auth login`, or set board.githubOwner in claw.config.json" };
    }
    try {
      const { stdout } = await execFileAsync("gh", [
        "repo", "list", owner,
        "--limit", "60",
        "--json", "name,pushedAt,description,isPrivate,primaryLanguage",
      ], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });

      const now = Date.now();
      const items: Repo[] = JSON.parse(stdout)
        .map((r: any) => ({
          name: r.name,
          pushedAt: r.pushedAt,
          daysAgo: Math.floor((now - new Date(r.pushedAt).getTime()) / 86_400_000),
          description: r.description ?? "",
          isPrivate: r.isPrivate,
          language: r.primaryLanguage?.name ?? null,
        }))
        .sort((a: Repo, b: Repo) => a.daysAgo - b.daysAgo);
      return { items };
    } catch (err: any) {
      // Say so. A silently empty panel reads as "no repos", which is a lie.
      return { items: [], error: `gh unavailable — ${String(err?.message ?? err).slice(0, 90)}` };
    }
  });
}

/** What this project itself has been doing. */
export async function commits(): Promise<{ items: { hash: string; subject: string; when: string }[]; error?: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["log", "-8", `--format=%h${SEP}%s${SEP}%cr`],
      { cwd: ROOT, timeout: 8000 },
    );
    return {
      items: stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [hash, subject, when] = line.split(SEP);
        return { hash, subject, when };
      }),
    };
  } catch (err: any) {
    return { items: [], error: String(err?.message ?? err).slice(0, 90) };
  }
}

/** What Cunning Claw actually did, from its own journal. */
export function journal(days = 3): { day: string; lines: string[] }[] {
  const dir = path.join(DATA_DIR, "journal");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, days)
    .map((f) => ({
      day: f.replace(".md", ""),
      lines: fs.readFileSync(path.join(dir, f), "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .slice(-14),
    }))
    .filter((d) => d.lines.length > 0);
}

const WX: Record<number, string> = {
  0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain",
  65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "showers",
  81: "showers", 82: "violent showers", 95: "thunderstorm", 96: "thunderstorm, hail",
};

/** Weather where you are. No key, no account. */
export async function weather(): Promise<{ place: string; now?: string; today?: string; error?: string }> {
  const place = config.board?.weatherPlace ?? "Cardiff";
  return cached("weather", 30 * 60_000, async () => {
    try {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`,
        { signal: AbortSignal.timeout(8000) },
      );
      const geo: any = await geoRes.json();
      const p = geo.results?.[0];
      if (!p) return { place, error: "location not found" };

      const wxRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}` +
        `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,` +
        `precipitation_probability_max,weather_code&timezone=auto&forecast_days=1`,
        { signal: AbortSignal.timeout(8000) },
      );
      const wx: any = await wxRes.json();
      return {
        place: p.name,
        now: `${Math.round(wx.current.temperature_2m)}°C, ${WX[wx.current.weather_code] ?? "—"}`,
        today: `${Math.round(wx.daily.temperature_2m_min[0])}–${Math.round(wx.daily.temperature_2m_max[0])}°C · ` +
               `${wx.daily.precipitation_probability_max[0]}% rain · ${WX[wx.daily.weather_code[0]] ?? "—"}`,
      };
    } catch (err: any) {
      return { place, error: String(err?.message ?? err).slice(0, 60) };
    }
  });
}

/** Everything the board needs, gathered in parallel. */
export async function board() {
  const [r, c, w] = await Promise.all([repos(), commits(), weather()]);
  return {
    at: new Date().toISOString(),
    weather: w,
    repos: r,
    commits: c,
    journal: journal(),
  };
}
