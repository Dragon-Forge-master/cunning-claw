import { config } from "./config.js";
import { runTurn, type AgentEvents } from "./agent.js";
import { readHeartbeat } from "./workspace.js";
import { beatDue, CREDIT_FAILURE, freshBackoff, recordBeat } from "./heartbeat-backoff.js";

let lastAt: string | null = null;

const backoff = freshBackoff();

export function heartbeatStatus() {
  return {
    enabled: config.heartbeat.enabled,
    intervalMinutes: config.heartbeat.intervalMinutes,
    lastAt,
    pausedUntil: backoff.pausedUntil ? new Date(backoff.pausedUntil).toISOString() : null,
  };
}

export function startHeartbeat(events: AgentEvents): void {
  if (!config.heartbeat.enabled) {
    console.log("  Heartbeat: off");
    return;
  }
  const ms = Math.max(1, config.heartbeat.intervalMinutes) * 60 * 1000;
  console.log(`  Heartbeat: every ${config.heartbeat.intervalMinutes}m`);
  setInterval(() => {
    if (!beatDue(backoff, Date.now())) return;
    // Watch this beat's own errors: a credit failure is noted here and shown
    // once as a notice, not as a ⚠ every half hour.
    let creditFailure = false;
    const watched: AgentEvents = {
      ...events,
      emit(event, data) {
        if (event === "agent_error" && CREDIT_FAILURE.test(String((data as any)?.message ?? ""))) {
          creditFailure = true;
          return;
        }
        events.emit(event, data);
      },
    };
    void runTurn(
      `[heartbeat]\nFollow HEARTBEAT.md. Checklist:\n${readHeartbeat()}\n` +
        `If nothing needs action, reply with exactly HEARTBEAT_OK and nothing else.`,
      watched,
      { kind: "heartbeat" },
    ).then((reply) => {
      if (reply !== null) lastAt = new Date().toISOString();
      // A turn refused because another was in flight is not a verdict either way.
      if (reply === null && !creditFailure) return;
      const notice = recordBeat(backoff, { creditFailure }, Date.now());
      if (notice) {
        console.log(`  ${notice}`);
        events.emit("notice", { message: notice });
      }
    });
  }, ms);
}
