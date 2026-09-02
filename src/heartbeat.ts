import { config } from "./config.js";
import { runTurn, type AgentEvents } from "./agent.js";
import { readHeartbeat } from "./workspace.js";

let lastAt: string | null = null;

export function heartbeatStatus() {
  return {
    enabled: config.heartbeat.enabled,
    intervalMinutes: config.heartbeat.intervalMinutes,
    lastAt,
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
    void runTurn(
      `[heartbeat]\nFollow HEARTBEAT.md. Checklist:\n${readHeartbeat()}\n` +
        `If nothing needs action, reply with exactly HEARTBEAT_OK and nothing else.`,
      events,
      { kind: "heartbeat" },
    ).then(() => {
      lastAt = new Date().toISOString();
    });
  }, ms);
}
