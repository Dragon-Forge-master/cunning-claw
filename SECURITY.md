# Security

Cunning Claw runs shell commands, reads files, drives a browser and can read your
inbox. A hole in it is a hole in your machine. Reports are genuinely welcome.

## Reporting

Email **cjvehiclespecialist@gmail.com** with `SECURITY` in the subject, or open a
[private advisory](https://github.com/Dragon-Forge-master/cunning-claw/security/advisories/new).

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

Four claims are load-bearing. Breaking any of them is a real finding:

1. `HARD_DENY` cannot be weakened by config.
2. Untrusted content is fenced as data and the fence cannot be closed from inside it.
3. Agent-written files are data; only human-authored workspace files carry authority.
4. A turn that can see untrusted content runs on a trusted brain, and taint is sticky.

Tests for all four live in `src/tools.test.ts`, `src/provenance.test.ts` and
`src/routing.test.ts`. If you break one, a test should have caught it — a passing
test suite alongside a working exploit is itself worth reporting.

## Scope

This is alpha software maintained by one person, and defence in depth is not a
guarantee. It has not had a professional audit. Run it on a machine where that is
an acceptable risk.
