import * as http from "./http.js";
import { injectionAlarm } from "./injection.js";
import { fenceUntrusted } from "./browser-ax.js";
import { cleanLabel, lastEntry } from "./visitor-log.js";
import { classifyHomeAction, homeStepMatch, validateCall, type EntityFacts } from "./home-policy.js";

/**
 * The home_assistant tool, out of tools.ts so the policy has one home.
 *
 * tools.ts keeps the schema and one line of dispatch; this decides. The order
 * is the point: validate (no card for a call that cannot be made), read the
 * entity (a cover's device class decides whether it is a blind or the garage),
 * classify, then ask — comfort through the ordinary gate, which a work order
 * can satisfy; security with a fresh card every time, or not at all while a
 * stranger's text is trying to give orders.
 */

export interface HomeCtx {
  requestApproval(summary: string, detail: string): Promise<boolean>;
}

/** What this needs from the world, injected so the tests can stand in for HA. */
export interface HomeDeps {
  /** tools.ts's gate(): a work order step, or a card. Comfort only. */
  gate(step: { tool: string; match: string }, summary: string, detail: string): Promise<boolean>;
  ready?: () => boolean;
  states?: (filter?: string) => Promise<string>;
  statesRaw?: typeof http.haStatesRaw;
  entity?: typeof http.haEntity;
  call?: typeof http.haCall;
  alarmed?: () => boolean;
  lastDoorbell?: () => string | null;
}

function factsFrom(raw: { state: string; attributes: Record<string, any> } | null): EntityFacts | undefined {
  if (!raw) return undefined;
  const a = raw.attributes ?? {};
  return {
    friendlyName: typeof a.friendly_name === "string" ? a.friendly_name : undefined,
    deviceClass: typeof a.device_class === "string" ? a.device_class : undefined,
    members: Array.isArray(a.entity_id) ? a.entity_id.map(String) : undefined,
  };
}

function describeData(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  return keys.length ? keys.map((k) => `${k} ${JSON.stringify(data[k])}`).join(", ") : "";
}

export async function homeAssistantTool(input: any, ctx: HomeCtx, deps: HomeDeps): Promise<string> {
  const ready = deps.ready ?? http.haReady;
  const action = String(input?.action ?? "states");

  if (action === "status") {
    const got = await (deps.statesRaw ?? http.haStatesRaw)();
    if (!got.ok) return got.error;
    return homeStatusText(got.states, (deps.lastDoorbell ?? lastDoorbellLine)());
  }
  if (action !== "call") return (deps.states ?? http.haStates)(input?.filter);

  const call = {
    domain: String(input?.domain ?? ""),
    service: String(input?.service ?? ""),
    entityId: String(input?.entityId ?? ""),
    data: input?.data,
  };
  const valid = validateCall(call);
  if (!valid.ok) return valid.error;
  // Before any card: approving something that cannot be sent teaches the
  // operator that the card is a formality.
  if (!ready()) return http.haStates();

  const facts = factsFrom(await (deps.entity ?? http.haEntity)(call.entityId));
  const verdict = classifyHomeAction(call, facts);
  const name = facts?.friendlyName ? `${cleanLabel(facts.friendlyName)} (${call.entityId})` : call.entityId;
  const settings = describeData(valid.data);
  const detail = `${name}\n${call.domain}.${call.service}${settings ? ` — ${settings}` : ""}`;

  if (verdict.cls === "security") {
    // Refused, not asked. A card raised now would be the stranger's request
    // wearing the operator's interface, and "unlock the door" is the one
    // request where a reflexive tap is not recoverable.
    if ((deps.alarmed ?? (() => Boolean(injectionAlarm())))()) {
      return (
        `Refused: ${call.domain}.${call.service} on ${call.entityId} is a security action (${verdict.why}), and this turn ` +
        "read outside text that tried to give instructions. Nothing was sent and no card was raised. " +
        "If the operator wants it, they ask again in a new message."
      );
    }
    // Never gate(): a work order or a task grant was given for an errand, and
    // opening the house is not part of anybody's errand by default.
    const ok = await ctx.requestApproval(
      `Security: ${call.domain}.${call.service} — ${name}`,
      `${detail}\n\n${verdict.why[0].toUpperCase()}${verdict.why.slice(1)}. ` +
        "Security actions always ask, every time; no plan and no \"allow for this task\" covers them.",
    );
    if (!ok) return "The operator declined the security action. Nothing was sent.";
  } else {
    const ok = await deps.gate(
      { tool: "home_assistant", match: homeStepMatch(call, valid.data) },
      "Control a smart-home device",
      detail,
    );
    if (!ok) return "The user declined the device control.";
  }

  const out = await (deps.call ?? http.haCall)(call.domain, call.service, call.entityId, valid.data);
  return /^Called /.test(out)
    ? `${out.replace(/\.$/, "")}${settings ? ` (${settings})` : ""}. Read the state back to confirm; HA's 200 means accepted, not done.`
    : out;
}

// ---------------------------------------------------------------------------
// home_status
// ---------------------------------------------------------------------------

export function lastDoorbellLine(): string | null {
  return lastEntry((l) => /doorbell pressed/.test(l));
}

function nameOf(e: any): string {
  return cleanLabel(String(e?.attributes?.friendly_name ?? e?.entity_id ?? "?"), 40) || String(e?.entity_id ?? "?");
}

function domainOf(e: any): string {
  return String(e?.entity_id ?? "").split(".")[0];
}

function list(names: string[], cap = 10): string {
  if (names.length <= cap) return names.join(", ");
  return `${names.slice(0, cap).join(", ")} and ${names.length - cap} more`;
}

const OPENING_SENSORS = new Set(["door", "window", "garage_door", "opening"]);
const OPENING_COVERS = new Set(["garage", "gate", "door", "window"]);

/**
 * A briefing-sized picture of the house. No clock in it and no counters of
 * our own (the Ouroboros guard in coherence.ts reads identical results as a
 * model re-asking, and a timestamp here would hide that); what changes between
 * two reads is the house itself.
 */
export function homeStatusText(states: any[], lastDoorbell: string | null): string {
  const live = states.filter((e) => e && typeof e.entity_id === "string" && !["unavailable", "unknown"].includes(String(e.state)));
  const lines: string[] = ["The house, from Home Assistant:"];

  const people = live.filter((e) => domainOf(e) === "person");
  lines.push(people.length
    ? `People: ${people.map((p) => {
      const s = String(p.state);
      return `${nameOf(p)} ${s === "home" ? "home" : s === "not_home" ? "away" : `at ${cleanLabel(s, 30)}`}`;
    }).join("; ")}.`
    : "People: no person.* entities (presence comes from the HA companion app on each phone).");

  const climate = live.filter((e) => domainOf(e) === "climate");
  if (climate.length) {
    lines.push(`Heating: ${climate.map((c) => {
      const a = c.attributes ?? {};
      const now = typeof a.current_temperature === "number" ? `${a.current_temperature} °C` : "no reading";
      const target = typeof a.temperature === "number" ? `, set to ${a.temperature} °C` : "";
      const doing = typeof a.hvac_action === "string" ? ` (${cleanLabel(a.hvac_action, 20)})` : "";
      return `${nameOf(c)} ${now}${target}, ${cleanLabel(String(c.state), 20)}${doing}`;
    }).join("; ")}.`);
  }

  const lights = live.filter((e) => domainOf(e) === "light" && e.state === "on").map(nameOf);
  lines.push(lights.length ? `Lights on: ${lights.length} — ${list(lights)}.` : "Lights on: none.");

  const open: string[] = [];
  for (const e of live) {
    const d = domainOf(e);
    const cls = String(e.attributes?.device_class ?? "");
    if (d === "binary_sensor" && OPENING_SENSORS.has(cls) && e.state === "on") open.push(nameOf(e));
    if (d === "cover" && OPENING_COVERS.has(cls) && (e.state === "open" || e.state === "opening")) open.push(nameOf(e));
    if (d === "lock" && e.state !== "locked" && e.state !== "locking") open.push(`${nameOf(e)} (${cleanLabel(String(e.state), 20)})`);
  }
  lines.push(open.length ? `Open or unlocked: ${list(open)}.` : "Open or unlocked: nothing.");

  const alarms = live.filter((e) => domainOf(e) === "alarm_control_panel");
  if (alarms.length) lines.push(`Alarm: ${alarms.map((a) => `${nameOf(a)} ${cleanLabel(String(a.state), 30)}`).join("; ")}.`);

  if (lastDoorbell) {
    // The log line is ours except for the caption, which is a model's words
    // about a stranger's image: take it out and fence it the usual way.
    const m = /\s·\s*camera caption[^<]*<untrusted source="camera caption">(.*?)<\/untrusted>/.exec(lastDoorbell);
    const fact = (m ? lastDoorbell.replace(m[0], "") : lastDoorbell).replace(/^- /, "");
    lines.push(`Last doorbell: ${fact}.`);
    if (m?.[1]) lines.push(fenceUntrusted("camera caption", m[1]));
  } else {
    lines.push("Last doorbell: none in the visitor log.");
  }
  return lines.join("\n");
}
