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
    ? "\nA local brain is in the catalog, but nothing answered on 127.0.0.1:11434.\nStart Ollama (`ollama serve`) or add ANTHROPIC_API_KEY to .env.\n"
    : "";
  return { ok: false, message: noKeyGuide() + extra };
}

export async function assertReadyToBoot(): Promise<void> {
  const result = await canBoot();
  if (result.ok) return;
  console.error(`\n${result.message}\n`);
  process.exit(1);
}
