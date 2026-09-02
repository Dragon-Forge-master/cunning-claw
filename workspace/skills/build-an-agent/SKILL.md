---
name: build-an-agent
label: Build an agent
category: forge
description: Build and deploy an AI agent for someone on Cloudflare, using the Agents SDK. Use when the operator asks you to build an agent, assistant, chatbot, or automation for a client or for one of the Forge properties.
---

# Build an agent on Cloudflare

Cloudflare is the default target unless the operator says otherwise. One CLI deploys everything,
the free tier is generous, and the operator already runs several private projects there.
An opinionated default is a feature — fewer decisions means fewer ways to fail.

## The model

An agent is a **Durable Object**. Each named instance is its own isolated agent with its own
SQLite state, its own schedule, and its own connections. That is what "many agents" means
here — you do not run one process that juggles users, you address an instance per user or
per job:

```ts
const agent = await getAgentByName(env.MyAgent, `client-${clientId}`);
```

Routing follows the same shape: `/agents/{agent-class}/{instance-name}`.
So `/agents/support-bot/acme-corp` is Acme's support agent, durable and separate from
everyone else's. Spawning a thousand is a thousand cheap DO instances, not a thousand servers.

## Scaffold

```bash
npm create cloudflare@latest <name> -- --template=cloudflare/agents-starter
cd <name> && npm install agents
```

`wrangler.jsonc` needs a DO binding and a migration per agent class:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

**Gotchas that will bite:** do not enable `experimentalDecorators` in tsconfig — it breaks
`@callable`. Never edit an existing migration; add a new tag. Every agent class needs both a
binding and a migration entry.

## What you get without building it

Reach for these before writing infrastructure by hand:

| Need | Use |
|---|---|
| Persistent memory | `this.setState()` / `` this.sql`…` `` — SQLite per instance |
| Run it on a schedule | `this.schedule(60, "task")`, cron strings, `scheduleEvery` |
| Long multi-step jobs | `this.runWorkflow()` — durable, survives eviction |
| Chat with streaming | `AIChatAgent` — resumable streams, tool calls, history |
| Ask a human first | `needsApproval` — human-in-the-loop is built in |
| Retries | `this.retry(fn, { maxAttempts: 5 })` — backoff and jitter |
| Handle email | Email routing with a secure reply resolver |
| Talk to other tools | MCP client, or build a server with `McpAgent` |

## Rules

- **Retrieve before you write.** This SDK moves fast and your training may be stale. Read
  `developers.cloudflare.com/agents/` for the API you are about to use rather than recalling it.
- Build and test locally with `npx wrangler dev` before deploying anything.
- Deploy with `npx wrangler deploy`. It raises an approval card — expected, and correct.
- Client secrets go in `wrangler secret put`, never in `wrangler.jsonc`, never in the repo.
- Use `needsApproval` for any agent action with real consequences. The same reasoning that
  governs you governs anything you build: human approval when consequences matter.
- Verify the deployment by opening the live URL, not by trusting the deploy log.
