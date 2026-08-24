/**
 * Claude Code's "when it's done, a browser opens on the glass."
 * Same idea: a viewport inside the HUD, not a new Chrome window.
 */

export type PreviewState = { open: boolean; url: string | null };

let state: PreviewState = { open: false, url: null };

export function previewState(): PreviewState {
  return { ...state };
}

export function parsePreviewUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Give me a URL to put on the glass." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    try {
      parsed = new URL(`http://${trimmed}`);
    } catch {
      return { ok: false, error: `Not a URL: ${trimmed}` };
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http(s) previews. No file:, javascript:, or data:." };
  }
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]" || parsed.hostname === "::") {
    parsed.hostname = "127.0.0.1";
  }
  return { ok: true, url: parsed.toString() };
}

export function openPreview(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const parsed = parsePreviewUrl(raw);
  if (!parsed.ok) return parsed;
  state = { open: true, url: parsed.url };
  return parsed;
}

export function closePreview(): PreviewState {
  state = { open: false, url: state.url };
  return previewState();
}

export function reloadPreview(): PreviewState {
  if (state.url) state = { open: true, url: state.url };
  return previewState();
}
