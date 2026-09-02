// Dragon Forge relay — the "Just works" retail tier.
//
// A customer's Cunning Claw speaks OpenAI-compatible chat to this Worker with
// its own DRAGONFORGE_TOKEN; we validate the token against KV, forward to
// OpenRouter on the house key, stream the answer back, and meter a monthly
// token budget.
//
// ============================================================================
// PRIVACY INVARIANT — the reason customers can trust this tier at all.
//
// The relay NEVER logs, stores, or inspects message content. No console.log
// of bodies, no KV writes of content, no analytics on prompts. The only
// things we read from a request are the Authorization header, the `model`
// field and the `stream` flag; the only thing we read from a non-streamed
// response is `usage.total_tokens`. Streamed bodies are piped through
// byte-for-byte with nothing but a length counter attached. We count tokens;
// we do not read words. Any change to this file that touches message content
// breaks the product's one promise — do not make it.
// ============================================================================
//
// Zero npm dependencies, matching the main codebase's two-runtime-dependency
// ethos: plain Worker APIs only, so there is no supply chain between a
// customer's conversation and OpenRouter. That is also why the handful of
// Workers types we need are declared inline rather than pulled from
// @cloudflare/workers-types.

import {
  errorBody,
  estimateStreamedTokens,
  isModelAllowed,
  isOverBudget,
  parseBearer,
  parseModels,
  parseTokenRecord,
  usageKey,
} from "./lib.ts";

// The slice of the KV and execution-context surface we actually use.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  TOKENS: KVNamespace;        // token records + usage counters
  OPENROUTER_KEY: string;     // the house provider key — `wrangler secret put OPENROUTER_KEY`
  MODELS?: string;            // comma-separated allowlist; see wrangler.toml [vars]
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Usage counters expire well after the month they cover, so KV tidies up old
// months by itself instead of accreting a key per customer per month forever.
const USAGE_TTL_SECONDS = 90 * 24 * 60 * 60;

function json(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Add to a customer's monthly counter. This is a read-modify-write, and KV is
 * eventually consistent, so two simultaneous requests from the same token can
 * race and one increment can be lost. Honestly: for v1 that is acceptable —
 * the counter is per-customer, a lost increment undercounts by one request,
 * and a single claw rarely runs parallel chats. If the retail tier grows real
 * concurrency this moves to a Durable Object per token.
 */
async function addUsage(kv: KVNamespace, key: string, tokens: number): Promise<void> {
  const current = parseInt((await kv.get(key)) ?? "0", 10) || 0;
  await kv.put(key, String(current + tokens), { expirationTtl: USAGE_TTL_SECONDS });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return json(200, JSON.stringify({ ok: true }));
    }

    if (url.pathname !== "/v1/chat/completions") {
      return json(404, errorBody("Not found. The relay serves POST /v1/chat/completions only."));
    }
    if (request.method !== "POST") {
      return json(405, errorBody("Use POST for /v1/chat/completions."));
    }

    // --- Authenticate ------------------------------------------------------
    const token = parseBearer(request.headers.get("authorization"));
    if (!token) {
      return json(401, errorBody("No Dragon Forge token. Send Authorization: Bearer <token>."));
    }

    const record = parseTokenRecord(await env.TOKENS.get(`tok:${token}`));
    if (!record) {
      return json(401, errorBody("That Dragon Forge token isn't recognised. Check it, or get in touch."));
    }
    if (record.disabled) {
      return json(403, errorBody("This Dragon Forge token has been disabled. Get in touch if that's a surprise."));
    }

    // --- Budget ------------------------------------------------------------
    const useKey = usageKey(token, new Date());
    const used = parseInt((await env.TOKENS.get(useKey)) ?? "0", 10) || 0;
    if (isOverBudget(used, record.monthlyBudgetTokens)) {
      return json(402, errorBody(
        "You've used this month's included tokens. Upgrade your plan, or your allowance refills when the month rolls over.",
      ));
    }

    // --- Validate the model against the allowlist --------------------------
    // We parse the body only to read `model` and `stream` — routing metadata,
    // not content — and we never log or store any of it.
    const rawBody = await request.text();
    let parsedBody: Record<string, unknown>;
    try {
      const p: unknown = JSON.parse(rawBody);
      if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("not an object");
      parsedBody = p as Record<string, unknown>;
    } catch {
      return json(400, errorBody("The request body must be a JSON chat completion request."));
    }

    const allowed = parseModels(env.MODELS);
    let forwardBody = rawBody;
    if (parsedBody.model === undefined) {
      // A claw that names no model gets the house default — this is the
      // "just works" tier, so an omitted field should not be a hard failure.
      parsedBody.model = allowed[0];
      forwardBody = JSON.stringify(parsedBody);
    } else if (!isModelAllowed(parsedBody.model, allowed)) {
      return json(400, errorBody(
        `That model isn't available on this plan. Available: ${allowed.join(", ")}.`,
      ));
    }

    const wantsStream = parsedBody.stream === true;

    // --- Forward to OpenRouter on the house key ----------------------------
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENROUTER_KEY}`,
      },
      body: forwardBody,
    });

    // Pass upstream errors through with their status but a fresh body read is
    // avoided for streams below; error bodies are small JSON and content-free
    // in the message sense (OpenRouter error text, not customer words).
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });

    if (wantsStream && upstream.ok && upstream.body) {
      // Pipe the SSE body through untouched, counting bytes only. Metering
      // for streams is an estimate — (request + response bytes) / 4 — because
      // reading the real usage figure would mean parsing the SSE frames,
      // which the privacy invariant forbids. See estimateStreamedTokens.
      const requestBytes = new TextEncoder().encode(forwardBody).byteLength;
      let responseBytes = 0;
      let settle: () => void;
      const finished = new Promise<void>((resolve) => { settle = resolve; });

      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          responseBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          settle();
        },
      });

      // waitUntil keeps the Worker alive to write the counter after the last
      // byte has gone to the client. If the client disconnects mid-stream the
      // flush may never fire; the metering for that request is then lost,
      // which — like the KV race — undercounts in the customer's favour.
      ctx.waitUntil(
        finished.then(() =>
          addUsage(env.TOKENS, useKey, estimateStreamedTokens(requestBytes, responseBytes)),
        ),
      );

      return new Response(upstream.body.pipeThrough(counter), {
        status: upstream.status,
        headers,
      });
    }

    // Non-streamed (and error) responses: read the JSON once, meter from the
    // exact usage.total_tokens OpenRouter reports, and hand the body on
    // unchanged. We look at the `usage` object and nothing else.
    const responseText = await upstream.text();
    if (upstream.ok) {
      let total = 0;
      try {
        const p = JSON.parse(responseText) as { usage?: { total_tokens?: unknown } };
        if (typeof p.usage?.total_tokens === "number") total = p.usage.total_tokens;
      } catch {
        // Not JSON — nothing safe to meter from; fall through to the estimate.
      }
      if (total <= 0) {
        const requestBytes = new TextEncoder().encode(forwardBody).byteLength;
        total = estimateStreamedTokens(requestBytes, new TextEncoder().encode(responseText).byteLength);
      }
      ctx.waitUntil(addUsage(env.TOKENS, useKey, total));
    }

    return new Response(responseText, { status: upstream.status, headers });
  },
};
