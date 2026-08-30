---
name: replicate-images
label: Replicate images
category: forge
description: Generate images (and other model outputs) through the Replicate MCP server — create a prediction, poll it, show the result. Use when the operator asks to generate, draw, or render an image, or to run a Replicate model.
---

# Generate images with Replicate

You have this. The mcp__replicate__ tools are real, connected, and verified
end-to-end on this machine. The whole job is three calls and a little patience.

## The dance — async is not an error

Replicate predictions are **asynchronous**. `create_prediction` returns
immediately with a prediction id and a status like `starting`. **That is
success, not failure.** The image does not exist yet; you go back for it.

1. **Create:**
   `mcp__replicate__create_prediction` with:
   ```json
   { "model": "black-forest-labs/flux-schnell",
     "input": { "prompt": "what the operator asked for, in vivid concrete detail" } }
   ```
   The reply reads `Created prediction <id>`. Note the id.

2. **Poll:** `mcp__replicate__get_prediction` with `{ "prediction_id": "<id>" }`.
   The reply is plain text lines — `Status: starting`, then `processing`, then
   `succeeded`. Wait a few seconds between polls; flux-schnell usually finishes
   in under ten seconds. Give up and tell the operator only after ~60 seconds or a
   `Status: failed` (the failure text says why — read it to them).

3. **Show it:** on `succeeded`, the `Output:` block holds image URL(s). Put one
   on the glass with `preview` (or `browser_open`). If the operator wants the file,
   download it with your shell to `~/` and say where you put it.

## The classic mistake — where the prompt goes

The prompt is NOT a top-level argument. `create_prediction` takes
`{"model": …, "input": {"prompt": …}}` — the prompt lives INSIDE `input`.
Called with a top-level prompt, Replicate runs the model with an empty input
and fails with "Required value missing: prompt" — which is your argument
shape, not a broken server. (The executor now auto-repairs the obvious case
and tells you when it did; do not rely on it.)

And read failures before reporting them: a `Status: failed` reply with an
`Error:` line is not an empty response — the Error line is the answer.

## Choosing a model — never from memory

- Default: `black-forest-labs/flux-schnell` — fast, good, about a penny, and
  **verified working on this machine**. Use it unless the operator names another.
- Higher quality when asked: `black-forest-labs/flux-1.1-pro` (slower, dearer).
- Anything else: the slug MUST come from `search_models` or `get_model` in this
  session — **never from your training memory**. Invented slugs
  (`stability-ai/stable-diffusion-xl` is not a real one; SDXL is
  `stability-ai/sdxl` and needs a `version` hash) are rejected by the API.
- **"An asynchronous error occurred. Please try again."** is the server's
  catch-all for a REJECTED create — wrong model slug, missing version, bad
  input. It is not transient and it is not about asynchrony: retrying the same
  call fails the same way. Fix the model slug (default to flux-schnell) or look
  the model up properly, then create again.

## Things that are already true — do not re-litigate them

- **Parameters live in your tool list.** Every mcp__replicate__ tool carries its
  full input schema in its definition, visible to you now. mcp_status is only a
  directory; it never shows schemas and does not need to.
- **The token is handled.** It lives in .env and is injected at connect time.
  If replicate ever shows disconnected in your turn header, say so — do not
  edit any config file (mcp.json is blocked anyway; mcp_add is the only door).
- Each image costs real money (pennies). Generate what was asked, not a
  gallery of variants — unless the operator asks for options.
