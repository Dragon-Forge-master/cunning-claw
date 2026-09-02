# Security

This software runs a shell, reads a screen, and drives a browser on someone's
machine. If you have found a way to make it do those things against its
operator's wishes, thank you for reading this first.

**Please do not open a public issue for anything exploitable.** Use GitHub's
**Report a vulnerability** button under this repository's Security tab — it
opens a private advisory only the maintainers can see. If that button is ever
missing, open a plain issue saying only "security — need a private channel"
with no details, and a maintainer will arrange one.

What counts: prompt-injection routes past the fences, approval-gate bypasses,
`HARD_DENY` escapes, redaction leaks (keys or personal data leaving the
machine), and anything that lets a web page, email or MCP server act without
the operator. We treat reports of the claw's own tools being turned against
its operator as the highest severity there is — that threat model is the
reason this project exists.
