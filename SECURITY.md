# Security

Cunning Claw runs shell commands, reads files, drives a browser and can read your
inbox. A hole in it is a hole in your machine. Reports are genuinely welcome.

## Reporting

Open a [private security advisory](https://github.com/Dragon-Forge-master/cunning-claw/security/advisories/new)
— it reaches the maintainers directly and stays private until a fix ships.

Please don't open a public issue for anything exploitable. Expect a reply within a
few days — this is maintained by one person.

Useful in a report: what you did, what happened, what you expected, and how bad
it could get. A proof of concept is welcome but not required.

## What counts

Especially interested in:

- **Prompt injection that survives the fence** — content from a web page, an email,
  an MCP server or a tool result that gets the model to act on it as an instruction.
- **Bypassing the command floor** — any shell construction that gets past `HARD_DENY`
  in `src/tools.ts`. That list is in code precisely so config cannot weaken it.
- **Escaping the approval gate** — a state-changing action reaching execution without
  a card, or a way to make a card misrepresent what will run.
- **Auth** — anything reaching `/api/*` without the token or the session cookie, or a
  cross-site request the Origin check lets through.
- **Credential leakage** — a secret reaching `data/history.json`, the journal, a
  written skill, the SSE stream or a log with the redaction in `src/redact.ts` intact.
- **Provenance confusion** — agent-written memory or skills being treated as operator
  instructions.

## What doesn't

- The user approving something destructive. The card is the boundary; it is meant to
  be readable, and reading it is the user's job.
- Configuring a permissive `autoApprovePatterns`. That is a documented footgun, and
  `HARD_DENY` still holds underneath it.
- A weak model falling for an injection when the trusted-brain guard is disabled.
  Turning the guard off is a choice with a stated consequence.
- Anything requiring an attacker who already has code execution as your user. At that
  point they do not need this software.

## Design notes for anyone auditing

Six claims are load-bearing. Breaking any of them is a real finding:

1. `HARD_DENY` cannot be weakened by config.
2. Untrusted content is fenced as data, and the fence cannot be closed from inside
   it — attribute included, not just the body.
3. Agent-written files are data; only human-authored workspace files carry authority.
   SCHEDULE.md is the sharp case: its entries fire unattended, so arming a new one
   raises an approval card and what fires is marked as a recollection, not an order.
4. A turn that can see untrusted content runs on a trusted brain, and taint is sticky.
5. The file denylist covers this install's own credentials — `.env`, the OAuth token
   store, the Chrome profile's cookies — and no tool may route around it. A browser
   navigation is a file read too: `browser_open` takes http(s) only.
6. Credentials are redacted on every path that leaves the machine, Telegram included.

Tests live beside the code they guard: `src/tools.test.ts`, `src/provenance.test.ts`,
`src/routing.test.ts`, `src/paths.test.ts`, `src/telegram.test.ts`, `src/schedule.test.ts`,
`src/browser.test.ts` and `src/mcp.test.ts`. If you break one, a test should have caught it — a passing
test suite alongside a working exploit is itself worth reporting.

## Scope

This is alpha software maintained by one person, and defence in depth is not a
guarantee. It has not had a professional audit. Run it on a machine where that is
an acceptable risk.
