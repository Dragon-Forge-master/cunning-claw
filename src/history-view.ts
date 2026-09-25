import { unstampUserMessage } from "./when.js";

/**
 * What the HUD shows when it reloads the transcript: plain operator text and
 * assistant text blocks, nothing the operator did not see live.
 *
 * Stored user turns carry framing the model needs and the operator does not:
 * a [context] block, the clock stamp from when.ts, and an [Armed skills]
 * preamble. Heartbeat turns are the claw talking to itself on a timer and
 * never belong in the transcript; a heartbeat that found nothing to say
 * (HEARTBEAT_OK) does not either. Pure, so the route stays one line and the
 * rules are tested.
 */
export type DisplayTurn = { role: "user" | "assistant"; text: string };

export function displayHistory(messages: readonly any[], contextEnd: string): DisplayTurn[] {
  const out: DisplayTurn[] = [];
  for (const m of messages) {
    if (m?.role === "user" && typeof m.content === "string") {
      const marker = m.content.indexOf(contextEnd);
      // Fall back to the old shape so history written before the marker still renders.
      const body = marker >= 0
        ? m.content.slice(marker + contextEnd.length).replace(/^\n+/, "")
        : m.content.replace(/^\[context[\s\S]*\]\n\n/, "");
      const text = unstampUserMessage(body);
      if (text.startsWith("[heartbeat]")) continue;
      out.push({ role: "user", text: text.replace(/^\[Armed skills[^\]]*\]\s*/, "") });
    } else if (m?.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (!text || text.trim() === "HEARTBEAT_OK") continue;
      // A heartbeat that did find something to say is shown: it was meant for the operator.
      out.push({ role: "assistant", text });
    }
  }
  return out;
}
