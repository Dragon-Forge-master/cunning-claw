import os from "node:os";

/**
 * Text bound for a room with strangers in it, with the machine taken out.
 *
 * Redaction removes secrets; it does not remove where the claw lives. A group
 * has strangers in it, so home paths, the hostname and LAN addresses come out
 * as well. The operator's private chat keeps them — it is the operator's own
 * machine they are reading about.
 *
 * This lived in telegram.ts, and ntfy needs it too: a public ntfy topic is a
 * room that anyone who guesses the name can sit in. But telegram.ts imports
 * the agent, so reaching it from anything the scheduler loads would close the
 * cycle agent → tools → schedule → ntfy → telegram → agent. It is a leaf for
 * the same reason redact.ts is — every sink must be able to reach it.
 */
export function groupSafeText(text: string, host = os.hostname()): string {
  let t = String(text ?? "")
    .replace(/(?:\/home|\/Users)\/[^\s/'"`)]+(?:\/[^\s'"`)]*)?/g, "[path]")
    .replace(/[A-Za-z]:\\Users\\[^\s'"`)]+/g, "[path]")
    .replace(/~\/[^\s'"`)]*/g, "[path]")
    .replace(/\b(?:10|127)(?:\.\d{1,3}){3}\b|\b192\.168(?:\.\d{1,3}){2}\b|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/g, "[local address]");
  if (host && host.length >= 3) t = t.split(host).join("[this machine]");
  return t;
}
