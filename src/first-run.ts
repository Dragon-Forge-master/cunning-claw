import { spawn } from "node:child_process";
import { brainHasKey, catalog, isLocalEndpoint } from "./brain.js";
import { noKeyGuide } from "./doctor.js";

/**
 * First-run gate. Lives outside server.ts so request handling stays untouched
 * (Claude owns that file) and a keyless boot never binds a dead HUD.
 */

export function hasUsableCloudKey(): boolean {
  return catalog().some((b) => {
    if (b.provider === "openai" && isLocalEndpoint(b.baseUrl)) return false;
    return brainHasKey(b);
  });
}

export function localBrainsConfigured(): boolean {
  return catalog().some((b) => b.provider === "openai" && isLocalEndpoint(b.baseUrl));
}

export function decideBoot(cloudReady: boolean, localConfigured: boolean, localReachable: boolean): boolean {
  if (cloudReady) return true;
  return localConfigured && localReachable;
}

async function localRuntimeReachable(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function canBoot(): Promise<{ ok: true } | { ok: false; message: string }> {
  const cloud = hasUsableCloudKey();
  const local = localBrainsConfigured();
  const reachable = local ? await localRuntimeReachable() : false;
  if (decideBoot(cloud, local, reachable)) return { ok: true };

  const extra = local && !reachable
    ? "\nA local brain is in the catalog, but nothing answered on 127.0.0.1:11434.\nStart Ollama (`ollama serve`) or add a cloud key to .env — the default roster wants OPENROUTER_API_KEY.\n"
    : "";
  return { ok: false, message: noKeyGuide() + extra };
}

/**
 * Whether the HUD should open on the setup page.
 *
 * Boot used to refuse outright without a key and print a guide to editing
 * .env — the one step a non-technical owner could not take. Now the server
 * starts anyway and sends them to /welcome, where a key is pasted, checked and
 * saved. Live: the moment a cloud key lands in process.env, or a local runtime
 * is confirmed, the HUD opens as normal.
 */
let localReady = false;
export function markLocalReady(ready = true): void {
  localReady = ready;
}
export function setupNeeded(): boolean {
  return !hasUsableCloudKey() && !localReady;
}
export { localRuntimeReachable };

/**
 * Open a page in the operator's own browser, once, at boot. Fire and forget:
 * no desktop (a server, CI, an ssh login) simply means nothing opens, and the
 * console line beside it still says where to go.
 */
export function openInBrowser(url: string): void {
  if (process.env.CLAW_NO_BROWSER || process.env.CI) return;
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : process.platform === "win32"
          ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
  } catch { /* no browser to open is not an error */ }
}

export async function prepareBoot(): Promise<void> {
  const result = await canBoot();
  if (result.ok) {
    markLocalReady(!hasUsableCloudKey());
    return;
  }
  console.warn(`\n${result.message}`);
  console.warn("  Or skip all of that: the setup page opens in your browser and does it for you.\n");
}
