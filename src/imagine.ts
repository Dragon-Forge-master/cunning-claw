import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

/**
 * Image generation on the key people already have.
 *
 * Pictures used to require the Replicate connector and its own token. But the
 * Gemini key most operators paste for their *brain* also paints — Google's
 * image model rides the same generativelanguage endpoint and the same AIza
 * key. One key, thinking and painting both, which is exactly the retail
 * promise. Replicate stays on the bench for the exotic models; this is the
 * default painter.
 *
 * The pure pieces (request builder, response parser) are separated so the
 * tests never touch the network, per the house rule.
 */

export const IMAGE_MODEL = "gemini-2.5-flash-image";

export function buildImageRequest(prompt: string): object {
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
}

export function imageEndpoint(model: string = IMAGE_MODEL): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** Pull the first inline image out of a generateContent response. */
export function parseImageResponse(body: any): { base64: string; mime: string } | null {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const d = p?.inlineData ?? p?.inline_data;
    if (d?.data) return { base64: String(d.data), mime: String(d.mimeType ?? d.mime_type ?? "image/png") };
  }
  return null;
}

/** A filename the shell and the Desk both like: slug of the prompt, stamped. */
export function imageFileName(prompt: string, now: Date, ext: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug}-${stamp}.${ext}`;
}

export interface ImagineDeps {
  fetchFn?: typeof fetch;
  apiKey?: string;
  outDir?: string;
  now?: Date;
}

export async function generateImage(
  prompt: string,
  deps: ImagineDeps = {},
): Promise<{ ok: boolean; message: string; file?: string }> {
  const apiKey = deps.apiKey ?? process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      message:
        "No GEMINI_API_KEY set — pictures need one. Paste a Google Gemini key on the Keys page " +
        "(free tier works), or connect Replicate for its model zoo.",
    };
  }
  const doFetch = deps.fetchFn ?? fetch;
  const res = await doFetch(imageEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(buildImageRequest(prompt)),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    return { ok: false, message: `Google's image endpoint answered HTTP ${res.status}: ${text}` };
  }
  const img = parseImageResponse(await res.json());
  if (!img) {
    return { ok: false, message: "Google answered but sent no image — likely a safety refusal for this prompt." };
  }
  const ext = img.mime.includes("jpeg") ? "jpg" : img.mime.includes("webp") ? "webp" : "png";
  const dir = deps.outDir ?? path.join(ROOT, "workspace", "images");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, imageFileName(prompt, deps.now ?? new Date(), ext));
  fs.writeFileSync(file, Buffer.from(img.base64, "base64"));
  return { ok: true, message: `Image saved to ${file}`, file };
}
