import fs from "node:fs";
import path from "node:path";
import type { InstallKind } from "./home-root.js";

/**
 * The update check: one small file from cunningclaw.com, once a day, only if
 * the owner said yes.
 *
 * The read-me promised "nothing here phones home", and that stays true by
 * default: until the owner answers the question (on the setup page, or once
 * on the HUD) nothing is fetched. Saying yes adds exactly one request a day —
 * a GET for https://cunningclaw.com/latest.json — and nothing else.
 *
 * What the request carries, and why so little:
 * - No identifier, no cookie, no query string, no referrer. Node's fetch has
 *   no cookie jar; there is no install id anywhere to send.
 * - A User-Agent of "CunningClaw" alone — not even the version. The
 *   comparison happens here, so the server has no use for it, and leaving it
 *   out makes every claw's request byte-for-byte the same: all it can tell
 *   the site, or anyone watching the wire, is that a claw exists at this
 *   address, which any page visit tells them anyway. A version would also
 *   mark which machines are behind on a security fix.
 * - redirect "error": the file comes from the URL the owner agreed to, or not
 *   at all.
 *
 * What comes back is treated as a stranger's words even though it is our own
 * site, because a site can be broken into: a size cap, a timeout, a strict
 * shape (semver only; links only to the project's GitHub or cunningclaw.com;
 * short summary lines with no control characters). The summary is display
 * text — the HUD sets it with textContent — and it never reaches the model:
 * nothing here is in the system prompt, a tool result or system_status. The
 * phones are told the version number and nothing from the summary.
 *
 * Nothing is ever downloaded or installed. The panel names the file for this
 * kind of install and links to it; the owner does the rest.
 *
 * A leaf: node built-ins and a type. Fetch, the clock, timers and where the
 * phones are come in as parameters (server.ts wires them), so all of it is
 * tested without a network.
 */

/** The one place the claw asks. Config may point elsewhere for testing (`updates.url`); the model never can. */
export const UPDATE_URL = "https://cunningclaw.com/latest.json";
export const USER_AGENT = "CunningClaw";
/** latest.json is under 2 KB; eight times that is room to grow, and no room for anything else. */
export const MAX_FEED_BYTES = 16 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A claw restarted five times while it is being set up should not ask five
 * times: the start-up check is skipped if one was made within the hour.
 */
export const STARTUP_GAP_MS = 60 * 60 * 1000;
/** How often the timer looks to see whether a day has passed. The check itself is daily. */
export const TICK_MS = 60 * 60 * 1000;
export const MAX_SUMMARY_LINES = 6;
export const MAX_SUMMARY_CHARS = 160;
const MAX_URL_CHARS = 300;

// ---------------------------------------------------------------------------
// Semver, including pre-releases (semver.org 2.0.0, section 11)
// ---------------------------------------------------------------------------

/** The grammar from semver.org, anchored. No leading "v", no leading zeros. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SemVer {
  /** Kept as digit strings: a version can outgrow a safe integer, and the grammar already forbids leading zeros. */
  core: [string, string, string];
  pre: string[];
}

export function parseSemver(s: unknown): SemVer | null {
  if (typeof s !== "string" || s.length > 64) return null;
  const m = SEMVER.exec(s);
  if (!m) return null;
  return { core: [m[1], m[2], m[3]], pre: m[4] ? m[4].split(".") : [] };
}

export function isSemver(s: unknown): s is string {
  return parseSemver(s) !== null;
}

/** Digit strings with no leading zeros compare by length first, then by character. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * -1, 0 or 1, by semver precedence: build metadata is ignored; a pre-release
 * comes before its release (1.0.0-rc.1 < 1.0.0); pre-release identifiers
 * compare one by one, numbers numerically and below any word, words in ASCII
 * order, and a longer list wins a tie (1.0.0-alpha < 1.0.0-alpha.1).
 * Throws on anything that is not semver: every caller validated first, so a
 * throw is a bug, never a guess.
 */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semantic version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) {
    const c = compareDigits(x.core[i], y.core[i]);
    if (c) return c;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const c = compareDigits(p, q);
      if (c) return c;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/**
 * Which file each kind of install wants, by installer and target. The targets
 * are scripts/bundle.mjs's own names, so the release's asset names line up.
 * Archives are the unzipped downloads; "deb" is listed so a feed can carry
 * one the day it ships.
 */
export const DOWNLOAD_KEYS = [
  "nsis-win-x64",
  "dmg-darwin-arm64",
  "dmg-darwin-x64",
  "appimage-linux-x64",
  "appimage-linux-arm64",
  "deb-linux-x64",
  "deb-linux-arm64",
  "archive-win-x64",
  "archive-darwin-arm64",
  "archive-darwin-x64",
  "archive-linux-x64",
  "archive-linux-arm64",
] as const;
export type DownloadKey = (typeof DOWNLOAD_KEYS)[number];

export interface Feed {
  version: string;
  /** The release date, YYYY-MM-DD. */
  date: string;
  security: boolean;
  summary: string[];
  notes: string;
  downloads: Partial<Record<DownloadKey, string>>;
}

export type FeedCheck = { ok: true; feed: Feed } | { ok: false; why: string };

/**
 * A link the panel may show: https, no credentials, no port, and only the
 * project's own places — its GitHub repository (releases, notes, assets) or
 * cunningclaw.com. Checked after URL parsing, so "/cunning-claw/../other"
 * has already become "/other" and fails. Returns the normalised form, which
 * is what was checked and what is shown.
 */
export function trustedLink(s: unknown): string | null {
  if (typeof s !== "string" || !s || s.length > MAX_URL_CHARS) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.hostname === "cunningclaw.com") return u.href;
  const repo = "/Dragon-Forge-master/cunning-claw";
  if (u.hostname === "github.com" && (u.pathname === repo || u.pathname.startsWith(repo + "/"))) return u.href;
  return null;
}

/** C0 and C1 controls, and the bidirectional overrides that can make a line read as something it is not. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Strict: a field that is present and wrong rejects the whole file, because
 * a feed that is half right is a feed someone has been editing. Fields this
 * version does not know are ignored rather than refused — otherwise the day
 * the feed grows one, every older claw would stop hearing about updates,
 * which is exactly when it most needs to — and nothing unknown is kept.
 */
export function validateFeed(raw: unknown): FeedCheck {
  const no = (why: string): FeedCheck => ({ ok: false, why });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return no("the file is not a JSON object");
  const r = raw as Record<string, unknown>;
  if (!isSemver(r.version)) return no("version is not a semantic version");
  if (!validDate(r.date)) return no("date is not a YYYY-MM-DD date");
  if (typeof r.security !== "boolean") return no("security is not true or false");
  if (!Array.isArray(r.summary) || r.summary.length > MAX_SUMMARY_LINES) return no(`summary is not a list of at most ${MAX_SUMMARY_LINES} lines`);
  const summary: string[] = [];
  for (const line of r.summary) {
    if (typeof line !== "string") return no("a summary line is not text");
    const t = line.trim();
    if (!t || t.length > MAX_SUMMARY_CHARS) return no(`a summary line is empty or longer than ${MAX_SUMMARY_CHARS} characters`);
    if (UNPRINTABLE.test(t)) return no("a summary line has control characters");
    summary.push(t);
  }
  const notes = trustedLink(r.notes);
  if (!notes) return no("notes is not a link to the project's releases or cunningclaw.com");
  if (!r.downloads || typeof r.downloads !== "object" || Array.isArray(r.downloads)) return no("downloads is not an object");
  const downloads: Partial<Record<DownloadKey, string>> = {};
  for (const key of DOWNLOAD_KEYS) {
    const v = (r.downloads as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const link = trustedLink(v);
    if (!link) return no(`downloads.${key} is not a link to the project's releases or cunningclaw.com`);
    downloads[key] = link;
  }
  return { ok: true, feed: { version: r.version, date: r.date, security: r.security, summary, notes, downloads } };
}

/**
 * Which URL to ask: the fixed one unless the owner's config names another
 * (for testing against a local server). https anywhere, or http to this
 * machine only; never credentials in the URL. null means "do not fetch".
 */
export function feedUrl(configured?: unknown): string | null {
  if (configured === undefined || configured === null || configured === "") return UPDATE_URL;
  if (typeof configured !== "string") return null;
  let u: URL;
  try {
    u = new URL(configured);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u.href;
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  return u.protocol === "http:" && loopback ? u.href : null;
}

/** The request, built where it can be tested: GET, two headers, no redirects. */
export function feedRequest(timeoutMs = FETCH_TIMEOUT_MS): RequestInit {
  return {
    method: "GET",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(timeoutMs),
  };
}

/**
 * Fetch and validate. Never throws; a failure says why in fixed words of our
 * own, never the server's, so nothing it sends reaches the glass unchecked.
 */
export async function fetchFeed(url: string, fetchImpl: typeof fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<FeedCheck> {
  const host = (() => {
    try { return new URL(url).host; } catch { return "the update site"; }
  })();
  let res: Response;
  try {
    res = await fetchImpl(url, feedRequest(timeoutMs));
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, why: `${host} did not answer within ${Math.round(timeoutMs / 1000)} seconds` };
    return { ok: false, why: `could not reach ${host}` };
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, why: `${host} answered HTTP ${res.status}` };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, why: `the file is larger than ${MAX_FEED_BYTES / 1024} KB` };
  }
  // Read it ourselves, counting: a missing or lying Content-Length must not
  // let a broken site stream megabytes into memory.
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FEED_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, why: `the file is larger than ${MAX_FEED_BYTES / 1024} KB` };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, why: `${host} stopped answering part-way` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return { ok: false, why: "the file is not JSON" };
  }
  return validateFeed(parsed);
}

// ---------------------------------------------------------------------------
// How to update this particular install
// ---------------------------------------------------------------------------

/** scripts/bundle.mjs's target name for this machine, or null where no build exists. */
export function targetOf(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!os || (arch !== "x64" && arch !== "arm64")) return null;
  if (os === "win" && arch !== "x64") return null;
  return `${os}-${arch}`;
}

export interface HowToUpdate {
  kind: InstallKind;
  /** Plain sentences, in order. */
  steps: string[];
  /** The one file for this machine, when the feed has it. */
  download?: { url: string; label: string };
  /** A command to type, for a clone. */
  command?: string;
}

const KIND_LABEL: Record<InstallKind, string> = {
  nsis: "Windows installer",
  dmg: "Mac disk image",
  appimage: "Linux AppImage",
  deb: "Linux .deb package",
  archive: "download",
  git: "git clone",
  unknown: "copy",
};

/**
 * The instructions the panel shows. No path is named (the HUD is filmed, and
 * "this folder" is enough); every link is one the feed validation passed.
 */
export function howToUpdate(kind: InstallKind, platform: NodeJS.Platform, arch: string, feed: Feed | null): HowToUpdate {
  if (kind === "git") {
    return {
      kind,
      command: "npm run update",
      steps: [
        "This claw is a git clone. Stop him, then in his folder run the command below, and start him again.",
        "It pulls the new code and installs its dependencies. Your keys, settings and memory are not touched.",
      ],
    };
  }
  const target = targetOf(platform, arch);
  const key = (target ? `${kind}-${target}` : "") as DownloadKey;
  const url = feed && (DOWNLOAD_KEYS as readonly string[]).includes(key) ? feed.downloads[key] : undefined;
  const download = url ? { url, label: `Download the ${KIND_LABEL[kind]}${feed ? ` for v${feed.version}` : ""}` } : undefined;
  const elsewhere = "The release notes list every file for every system.";
  switch (kind) {
    case "nsis":
      return { kind, download, steps: [
        "Download the new installer and run it. It installs over this one; your keys, settings and memory stay in your own folder.",
        "Close Cunning Claw first if the installer asks.",
        ...(download ? [] : [elsewhere]),
      ] };
    case "dmg":
      return { kind, download, steps: [
        "Quit Cunning Claw, open the new disk image and drag Cunning Claw into Applications, replacing the old one.",
        "Your keys, settings and memory stay in your own folder.",
        ...(download ? [] : [elsewhere]),
      ] };
    case "appimage":
      return { kind, download, steps: [
        "Quit Cunning Claw, download the new AppImage, allow it to run as a program (Properties → Permissions), and use it in place of the old file.",
        "Your keys, settings and memory stay in your own folder.",
        ...(download ? [] : [elsewhere]),
      ] };
    case "deb":
      return { kind, download, steps: [
        "Quit Cunning Claw and install the new package over this one with your software installer.",
        "Your keys, settings and memory stay in your own folder.",
        ...(download ? [] : [elsewhere]),
      ] };
    case "archive":
      return { kind, download, steps: [
        "Download the new archive and unpack it beside this folder. Keep this one until the new one works.",
        "Quit this claw, then start the new one once from a terminal with --import and the path of this folder: it copies your keys, memory and notes across.",
        ...(download ? [] : [elsewhere]),
      ] };
    default:
      return { kind, steps: ["The release notes say how to update, and list every file for every system."] };
  }
}

// ---------------------------------------------------------------------------
// The owner's answer, and the last result
// ---------------------------------------------------------------------------

export type Consent = "unanswered" | "yes" | "no";

export interface UpdateSettings {
  /** Default "unanswered", which checks nothing: the answer is the owner's. */
  consent: Consent;
  /** One message per new version to the phone lines that are set up. On unless turned off. */
  phoneNote: boolean;
}

export const DEFAULT_SETTINGS: UpdateSettings = { consent: "unanswered", phoneNote: true };
const SETTINGS_FILE = "updates.json";
const CACHE_FILE = "update-check.json";

interface Cache {
  checkedAt: string | null;
  result: "ok" | "failed" | null;
  why?: string;
  feed?: Feed;
  /** The newest version already told to the phones, so each is told once. */
  notified?: string;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, name + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, name));
}

export function loadSettings(dir: string): UpdateSettings {
  const r = readJson(path.join(dir, SETTINGS_FILE));
  return {
    consent: r.consent === "yes" || r.consent === "no" ? r.consent : DEFAULT_SETTINGS.consent,
    phoneNote: typeof r.phoneNote === "boolean" ? r.phoneNote : DEFAULT_SETTINGS.phoneNote,
  };
}

/** The cache is re-validated on the way in: a file edited on disk is held to the same shape as one fetched. */
function loadCache(dir: string): Cache {
  const r = readJson(path.join(dir, CACHE_FILE));
  const checked = typeof r.checkedAt === "string" && !Number.isNaN(Date.parse(r.checkedAt)) ? r.checkedAt : null;
  const fed = r.feed === undefined ? null : validateFeed(r.feed);
  return {
    checkedAt: checked,
    result: r.result === "ok" || r.result === "failed" ? r.result : null,
    why: typeof r.why === "string" ? r.why.slice(0, 200) : undefined,
    feed: fed?.ok ? fed.feed : undefined,
    notified: isSemver(r.notified) ? r.notified : undefined,
  };
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

export interface UpdateStatus {
  current: string;
  consent: Consent;
  phoneNote: boolean;
  checking: boolean;
  checkedAt: string | null;
  result: "ok" | "failed" | null;
  why: string | null;
  latest: Pick<Feed, "version" | "date" | "security" | "summary" | "notes"> | null;
  /** A version newer than this one is known. */
  newer: boolean;
  security: boolean;
  /**
   * Whether any phone line (Telegram, Discord, ntfy, Pocket Claw with push)
   * is set up. The panel offers the phone note only when there is somewhere
   * for it to go; a yes or no, never which line or whose.
   */
  phones: boolean;
  install: HowToUpdate;
  /** One line, no clock in it: what the telemetry and the console say. */
  text: string;
}

/** What the phones are told: the version and where to look. Never a summary line. */
export function phoneNoteText(feed: Pick<Feed, "version" | "security">): string {
  return feed.security
    ? `Cunning Claw v${feed.version} is out, a security update — open the HUD to see what's new`
    : `Cunning Claw v${feed.version} is out — open the HUD to see what's new`;
}

/**
 * Non-volatile on purpose (CLAUDE.md, the Ouroboros guard): no time and no
 * counter, only states that change when something has.
 */
export function statusText(s: Pick<UpdateStatus, "consent" | "current" | "result" | "why" | "latest" | "newer" | "security">): string {
  // A newer version already known outranks a failed check since: the site
  // being down for an hour does not make the waiting update any less real.
  if (s.newer && s.latest) return s.security ? `Updates: security update v${s.latest.version} is ready` : `Updates: v${s.latest.version} is ready`;
  if (s.result === "failed" && s.why) return `Updates: the last check failed — ${s.why}`;
  if (s.result === "ok" && s.latest) return `Updates: v${s.current} is the newest`;
  if (s.consent === "unanswered") return "Updates: not checking (not asked yet)";
  if (s.consent === "no") return "Updates: daily check off";
  return "Updates: daily check on";
}

export interface UpdatesDeps {
  dataDir: string;
  /** This claw's version (package.json). */
  current: string;
  /** From feedUrl(): null means the config named something unusable, and nothing is fetched. */
  url: string | null;
  fetch: typeof fetch;
  now: () => number;
  install: InstallKind;
  platform: NodeJS.Platform;
  arch: string;
  /** Every status change, for the HUD (server.ts broadcasts it). */
  emit?: (status: UpdateStatus) => void;
  /** One short line to each phone line that is set up. */
  notify?: (text: string) => void;
  /** Whether any phone line is set up now. Left out, the claw assumes none. */
  phones?: () => boolean;
  log?: (line: string) => void;
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  timeoutMs?: number;
}

export function createUpdates(deps: UpdatesDeps) {
  let settings = loadSettings(deps.dataDir);
  let cache = loadCache(deps.dataDir);
  let inFlight: Promise<UpdateStatus> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const timers = deps.timers ?? { setInterval, clearInterval };
  // A version string we did not make is never compared: an unparseable
  // package.json version means "do not claim anything is newer".
  const currentOk = isSemver(deps.current);

  function newer(): boolean {
    return Boolean(currentOk && cache.feed && compareSemver(cache.feed.version, deps.current) > 0);
  }

  function status(): UpdateStatus {
    const f = cache.feed ?? null;
    const isNewer = newer();
    const s: Omit<UpdateStatus, "text"> = {
      current: deps.current,
      consent: settings.consent,
      phoneNote: settings.phoneNote,
      checking: inFlight !== null,
      checkedAt: cache.checkedAt,
      result: cache.result,
      why: cache.result === "failed" ? cache.why ?? null : null,
      latest: f ? { version: f.version, date: f.date, security: f.security, summary: f.summary, notes: f.notes } : null,
      newer: isNewer,
      security: Boolean(isNewer && f?.security),
      phones: phonesSetUp(),
      install: howToUpdate(deps.install, deps.platform, deps.arch, isNewer ? f : null),
    };
    return { ...s, text: statusText(s) };
  }

  const changed = () => deps.emit?.(status());

  function phonesSetUp(): boolean {
    try {
      return Boolean(deps.phones?.());
    } catch {
      return false;
    }
  }

  function saveCache(): void {
    try {
      writeJson(deps.dataDir, CACHE_FILE, cache);
    } catch (err) {
      deps.log?.(`Updates: could not save the last result — ${(err as Error).message}`);
    }
  }

  /**
   * Tell the phones once per version: only when the owner said yes to
   * checks, kept the note on, a phone line is set up, and this version is
   * newer than both this claw and the last one told. Recorded before it is
   * sent, so a crash part-way cannot make a second message. With no phone
   * line the version is not used up: one set up later hears of it at the
   * next daily check, once.
   */
  function maybeNotify(): void {
    const f = cache.feed;
    if (!f || !newer() || settings.consent !== "yes" || !settings.phoneNote || !phonesSetUp()) return;
    if (cache.notified && compareSemver(f.version, cache.notified) <= 0) return;
    cache.notified = f.version;
    saveCache();
    try {
      deps.notify?.(phoneNoteText(f));
    } catch { /* a phone that did not buzz is not a failed check */ }
  }

  async function run(): Promise<UpdateStatus> {
    const url = deps.url;
    const out: FeedCheck = url
      ? await fetchFeed(url, deps.fetch, deps.timeoutMs)
      : { ok: false, why: "updates.url in the config is not an https address" };
    cache.checkedAt = new Date(deps.now()).toISOString();
    if (out.ok) {
      cache.result = "ok";
      cache.why = undefined;
      cache.feed = out.feed;
    } else {
      // The last good answer stays: a site that is down for an hour does
      // not make an update that is waiting disappear from the glass.
      cache.result = "failed";
      cache.why = out.why;
    }
    saveCache();
    if (out.ok) maybeNotify();
    return status();
  }

  /**
   * One check at a time; a second press while one is running waits for it.
   * It answers with the status from after the check is over: run()'s own
   * status is taken while the check is still in flight, and an HTTP reply
   * saying "checking" that landed after the event stream's "done" left the
   * HUD's button reading CHECKING… for good (found driving the HUD).
   */
  function check(): Promise<UpdateStatus> {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
      changed();
    }).then(() => status());
    changed();
    return inFlight;
  }

  function sinceLast(): number {
    return cache.checkedAt ? deps.now() - Date.parse(cache.checkedAt) : Infinity;
  }

  /** The timer's job: a check when the owner said yes and a day has passed. */
  async function tick(): Promise<void> {
    if (settings.consent !== "yes" || sinceLast() < DAY_MS) return;
    await check();
  }

  return {
    status,
    /** "Check now": the owner pressed it, so it runs whatever the daily setting says. */
    checkNow: check,
    tick,
    /** The answer to the question. No forgets the last result, so the chip goes back to how it was. */
    setConsent(yes: boolean): UpdateStatus {
      settings = { ...settings, consent: yes ? "yes" : "no" };
      writeJson(deps.dataDir, SETTINGS_FILE, settings);
      if (!yes) {
        cache = { checkedAt: null, result: null, notified: cache.notified };
        saveCache();
      }
      changed();
      if (yes && sinceLast() >= STARTUP_GAP_MS) void check();
      return status();
    },
    setPhoneNote(on: boolean): UpdateStatus {
      settings = { ...settings, phoneNote: on };
      writeJson(deps.dataDir, SETTINGS_FILE, settings);
      changed();
      return status();
    },
    /** At boot: one check if the owner said yes (and none was made this hour), then the daily timer. */
    start(): void {
      deps.log?.(status().text);
      if (settings.consent === "yes" && sinceLast() >= STARTUP_GAP_MS) void check();
      timer ??= timers.setInterval(() => void tick().catch(() => {}), TICK_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
