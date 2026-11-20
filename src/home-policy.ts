/**
 * What the claw may ask Home Assistant to do, and how hard it must ask.
 *
 * Two questions, kept apart because they fail differently.
 *
 * 1. Is the call well formed? `validateCall` is an allow-list per domain and
 *    service, with every data key named and bounded. The model used to be able
 *    to name any domain.service at all, and had no way to say how bright or
 *    how warm, so the useful calls were impossible and the dangerous ones
 *    (homeassistant.restart, shell_command.*, notify.* to anybody) were one
 *    card away. A key that is not on the list is refused with the list, so the
 *    model can correct itself; `entity_id` in the data is refused by name,
 *    because haCall spread the data over the target and it would have swapped
 *    the lamp on the card for the lock behind it.
 *
 * 2. What happens if it goes wrong? `classifyHomeAction` sorts a valid call
 *    into comfort or security. Comfort is lights, heating within a sane range,
 *    music, fans, blinds, scenes: reversible, and the worst case is a cold or
 *    bright room. Security is anything that opens the home or stops it being
 *    watched — unlock, disarm, a garage door or gate, a siren, an automation
 *    switched off. Those always raise a fresh card, can never ride a task
 *    grant or a work order, and are refused outright while the turn is alarmed
 *    by the injection scanner (src/home.ts enforces this; the work-order check
 *    in src/workorder.ts refuses them at plan time).
 *
 * Conservative by construction, like consequence.ts: a cover whose device class
 * could not be read is treated as a garage door, because a false card costs a
 * tap and a false pass opens the house.
 *
 * Pure: no imports, so workorder.ts and the tests can use it without pulling in
 * the network.
 */

export interface ServiceCall {
  domain: string;
  service: string;
  entityId: string;
  data?: unknown;
}

type Check = (v: unknown) => { ok: true; value: unknown } | { ok: false; why: string };

interface KeySpec {
  check: Check;
  /** For the refusal message, so the model learns the range without a second try. */
  hint: string;
  required?: boolean;
}

type ServiceSpec = Record<string, KeySpec>;

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Some brains send "40" for 40. Accept a plain decimal string, nothing looser.
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function num(min: number, max: number, unit = ""): KeySpec {
  return {
    hint: `${min}–${max}${unit}`,
    check: (v) => {
      const n = toNumber(v);
      if (n === null) return { ok: false, why: "must be a number" };
      if (n < min || n > max) return { ok: false, why: `must be between ${min} and ${max}${unit}` };
      return { ok: true, value: n };
    },
  };
}

function int(min: number, max: number, unit = ""): KeySpec {
  const base = num(min, max, unit);
  return {
    hint: base.hint,
    check: (v) => {
      const r = base.check(v);
      if (!r.ok) return r;
      return Number.isInteger(r.value) ? r : { ok: false, why: "must be a whole number" };
    },
  };
}

function oneOf(values: readonly string[]): KeySpec {
  return {
    hint: values.join(" | "),
    check: (v) => (typeof v === "string" && values.includes(v)
      ? { ok: true, value: v }
      : { ok: false, why: `must be one of ${values.join(", ")}` }),
  };
}

const bool: KeySpec = {
  hint: "true | false",
  check: (v) => (typeof v === "boolean" ? { ok: true, value: v } : { ok: false, why: "must be true or false" }),
};

/** A preset or option name: what HA shows in its own UI, not free text. */
const label: KeySpec = {
  hint: "a name from the entity's own list",
  check: (v) => (typeof v === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(v)
    ? { ok: true, value: v }
    : { ok: false, why: "must be a short name (letters, digits, spaces, _ and -)" }),
};

const rgb: KeySpec = {
  hint: "[r, g, b], each 0–255",
  check: (v) => {
    if (!Array.isArray(v) || v.length !== 3) return { ok: false, why: "must be [r, g, b]" };
    const out: number[] = [];
    for (const c of v) {
      const n = toNumber(c);
      if (n === null || !Number.isInteger(n) || n < 0 || n > 255) return { ok: false, why: "each of r, g, b must be a whole number 0–255" };
      out.push(n);
    }
    return { ok: true, value: out };
  },
};

const req = (k: KeySpec): KeySpec => ({ ...k, required: true });

export const HVAC_MODES = ["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"] as const;

/**
 * Heating is comfort only inside a range a person would choose. 5 °C is frost
 * protection; past 30 °C nobody is asking for comfort, and a model that sets
 * 90 has misread something.
 */
export const CLIMATE_MIN_C = 5;
export const CLIMATE_MAX_C = 30;

const transition = num(0, 300, " s");
const none: ServiceSpec = {};

/** Every service the claw may call, and every key each one takes. */
export const SERVICES: Record<string, Record<string, ServiceSpec>> = {
  light: {
    turn_on: { brightness_pct: num(0, 100, "%"), color_temp_kelvin: int(1500, 9000, " K"), rgb_color: rgb, transition },
    turn_off: { transition },
    toggle: { transition },
  },
  switch: { turn_on: none, turn_off: none, toggle: none },
  input_boolean: { turn_on: none, turn_off: none, toggle: none },
  fan: {
    turn_on: { percentage: int(0, 100, "%") },
    turn_off: none,
    toggle: none,
    set_percentage: { percentage: req(int(0, 100, "%")) },
    oscillate: { oscillating: req(bool) },
  },
  climate: {
    set_temperature: { temperature: req(num(CLIMATE_MIN_C, CLIMATE_MAX_C, " °C")), hvac_mode: oneOf(HVAC_MODES) },
    set_hvac_mode: { hvac_mode: req(oneOf(HVAC_MODES)) },
    set_preset_mode: { preset_mode: req(label) },
    turn_on: none,
    turn_off: none,
  },
  cover: {
    open_cover: none,
    close_cover: none,
    stop_cover: none,
    toggle: none,
    set_cover_position: { position: req(int(0, 100, "%")) },
  },
  media_player: {
    turn_on: none, turn_off: none, toggle: none,
    media_play: none, media_pause: none, media_stop: none, media_play_pause: none,
    media_next_track: none, media_previous_track: none,
    volume_up: none, volume_down: none,
    volume_set: { volume_level: req(num(0, 1)) },
    volume_mute: { is_volume_muted: req(bool) },
    // play_media is absent on purpose: it takes a URL, and a URL from a turn
    // that read a stranger's text is how a speaker in the kitchen says
    // whatever the stranger wanted said.
  },
  // Scenes and scripts take no data: what they do is defined in HA, by the
  // operator, and the card names which one.
  scene: { turn_on: none },
  script: { turn_on: none, turn_off: none },
  humidifier: { turn_on: none, turn_off: none, set_humidity: { humidity: req(int(0, 100, "%")) } },
  vacuum: { start: none, stop: none, pause: none, return_to_base: none, locate: none },
  input_number: { set_value: { value: req(num(-1e6, 1e6)) } },
  input_select: { select_option: { option: req(label) } },
  button: { press: none },
  // Security domains. No `code`, ever: a PIN that passes through the model is
  // in the transcript, the journal and the provider's logs. A panel or lock
  // that needs one is armed or opened from HA's own app.
  lock: { lock: none, unlock: none, open: none },
  alarm_control_panel: {
    alarm_arm_home: none, alarm_arm_away: none, alarm_arm_night: none, alarm_arm_vacation: none,
    alarm_disarm: none, alarm_trigger: none,
  },
  siren: { turn_on: none, turn_off: none, toggle: none },
  automation: { turn_on: none, turn_off: none, trigger: none },
};

/**
 * Domains refused whatever the service, with the reason the model is given.
 * Most of these are a shell, a message to a third party, or HA itself.
 */
export const REFUSED_DOMAINS: Record<string, string> = {
  notify: "messages to people go through the claw's own phone lines (the notify tool), not HA's notify services",
  persistent_notification: "messages go through the claw's own phone lines, not HA",
  tts: "the claw does not speak through the house's speakers — a turn that read a stranger's text could make them say anything",
  shell_command: "a shell command on the HA host is run_command on someone else's machine, without its sandbox or its card",
  command_line: "a shell command on the HA host is run_command without the sandbox",
  rest_command: "an HTTP request from HA bypasses the claw's own allowlist",
  python_script: "a script on the HA host is code execution",
  pyscript: "a script on the HA host is code execution",
  hassio: "add-ons, backups and the supervisor are HA administration, not home control",
  homeassistant: "restart, stop and reload are HA administration; turn devices on and off by their own domain",
  recorder: "purging history is not home control",
  logger: "logging is HA administration",
  system_log: "logging is HA administration",
  backup: "backups are HA administration",
  camera: "camera.snapshot and camera.record write files on the HA host — a still is the look tool, which asks",
  conversation: "HA's own assistant would take instructions second-hand",
};

const ID_PART = /^[a-z][a-z0-9_]{0,63}$/;
const ENTITY_ID = /^[a-z][a-z0-9_]{0,63}\.[a-z0-9_]{1,128}$/;
/** HA's target keys: one entity per call, named on the card. */
const TARGET_KEYS = new Set(["entity_id", "area_id", "device_id", "floor_id", "label_id"]);

export type Validated =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

/** Check one service call against the allow-list. Returns the cleaned data. */
export function validateCall(call: ServiceCall): Validated {
  const domain = String(call.domain ?? "").trim();
  const service = String(call.service ?? "").trim();
  const entityId = String(call.entityId ?? "").trim();
  // These go into a URL path (/api/services/<domain>/<service>).
  if (!ID_PART.test(domain) || !ID_PART.test(service)) {
    return { ok: false, error: "domain and service are lower-case names such as light and turn_on." };
  }
  if (REFUSED_DOMAINS[domain]) {
    return { ok: false, error: `Refused: ${domain}.* is not something the claw calls — ${REFUSED_DOMAINS[domain]}.` };
  }
  const services = SERVICES[domain];
  if (!services) {
    return {
      ok: false,
      error: `${domain} is not on the home allow-list. Supported: ${Object.keys(SERVICES).join(", ")}. ` +
        "A new domain is added in src/home-policy.ts, with its keys and their ranges.",
    };
  }
  const spec = services[service];
  if (!spec) {
    return { ok: false, error: `${domain} takes ${Object.keys(services).map((s) => `${domain}.${s}`).join(", ")} — not ${domain}.${service}.` };
  }
  if (!ENTITY_ID.test(entityId)) {
    return { ok: false, error: "entityId must be one entity id, such as light.kitchen — not a list, an area or a pattern." };
  }
  // The domain of the service must be the entity's own. Otherwise
  // light.turn_on could be aimed at lock.front_door, or homeassistant.turn_off
  // at the alarm, and the classification below would be reading the wrong one.
  if (entityId.split(".")[0] !== domain) {
    return { ok: false, error: `${entityId} is not a ${domain} entity. Call the service from its own domain (${entityId.split(".")[0]}.…).` };
  }

  const raw = call.data ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "data must be an object of named values, e.g. {\"brightness_pct\": 40}." };
  }
  const takes = Object.entries(spec).map(([k, s]) => `${k} (${s.hint})`).join(", ") || "no data";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (TARGET_KEYS.has(key)) {
      return { ok: false, error: `"${key}" does not go in data — the target is entityId, one entity per call, so the card shows exactly which.` };
    }
    if (key === "code") {
      return { ok: false, error: "A PIN or code is never passed through the claw. Use HA's own app for a lock or alarm that needs one." };
    }
    const ks = spec[key];
    if (!ks) return { ok: false, error: `${domain}.${service} does not take "${key}". It takes: ${takes}.` };
    const r = ks.check(value);
    if (!r.ok) return { ok: false, error: `${domain}.${service}: ${key} ${r.why}.` };
    out[key] = r.value;
  }
  for (const [key, ks] of Object.entries(spec)) {
    if (ks.required && !(key in out)) return { ok: false, error: `${domain}.${service} needs ${key} (${ks.hint}).` };
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// Consequence
// ---------------------------------------------------------------------------

export type HomeClass = "comfort" | "security";

/** What HA says about the entity, when it could be read. */
export interface EntityFacts {
  friendlyName?: string;
  deviceClass?: string;
  /** A scene's members (HA puts them in the scene's entity_id attribute). */
  members?: string[];
}

/**
 * Words in an id or a name that mean "this opens the home". Matched as whole
 * words split on _ - . and spaces, so "outdoor_lights" is not a door and
 * "front_door_lock" is.
 */
const OPENS_WORDS = new Set([
  "garage", "gate", "gates", "door", "doors", "frontdoor", "backdoor", "entrance", "entry",
  "lock", "locks", "unlock", "deadbolt", "latch", "alarm", "disarm", "intercom", "buzzer", "opener",
]);
const OPENING_COVER_CLASSES = new Set(["garage", "gate", "door"]);
const SECURITY_DOMAINS = new Set(["alarm_control_panel", "siren", "automation"]);
/** Domains where the name is the only clue to what the thing does. */
const NAMED_BY_OPERATOR = new Set(["switch", "button", "script", "scene", "input_boolean"]);

function words(text: string | undefined): string[] {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function namedToOpen(entityId: string, facts?: EntityFacts): boolean {
  const object = entityId.split(".").slice(1).join(".");
  return [...words(object), ...words(facts?.friendlyName)].some((w) => OPENS_WORDS.has(w));
}

/**
 * Sort a VALID call into comfort or security. `facts` is what HA said about
 * the entity just before the call; absent means it could not be read.
 */
export function classifyHomeAction(call: ServiceCall, facts?: EntityFacts): { cls: HomeClass; why: string } {
  const { domain, service, entityId } = call;
  if (domain === "lock") {
    // Locking makes the home safer and is undone by unlocking — which asks.
    if (service === "lock") return { cls: "comfort", why: "locking closes the home" };
    return { cls: "security", why: "unlocking or opening a lock opens the home" };
  }
  if (domain === "alarm_control_panel") return { cls: "security", why: "arming and disarming change whether the home is watched" };
  if (domain === "siren") return { cls: "security", why: "a siren is an alarm, on or off" };
  if (SECURITY_DOMAINS.has(domain)) return { cls: "security", why: "an automation can do anything, and switching one off can stop the house watching itself" };
  if (domain === "cover") {
    if (!facts) return { cls: "security", why: "the cover's device class could not be read, so it is treated as a garage door" };
    if (OPENING_COVER_CLASSES.has(String(facts.deviceClass ?? ""))) {
      return { cls: "security", why: `a ${facts.deviceClass} cover opens the home` };
    }
    if (namedToOpen(entityId, facts)) return { cls: "security", why: "its name says it is a door, gate or garage" };
    return { cls: "comfort", why: "a blind or shade" };
  }
  if (domain === "scene" && facts?.members?.some((m) => /^(lock|alarm_control_panel|siren)\./.test(m) || /^cover\..*(garage|gate|door)/.test(m))) {
    return { cls: "security", why: "the scene includes a lock, alarm, siren or door" };
  }
  if (NAMED_BY_OPERATOR.has(domain) && namedToOpen(entityId, facts)) {
    return { cls: "security", why: "its name says it opens a door, gate or lock, or touches the alarm" };
  }
  return { cls: "comfort", why: "reversible" };
}

/**
 * The exact string a work-order step must carry to cover this call. Data is
 * part of it, so "light.turn_on light.kitchen {brightness_pct:40}" cannot be
 * stretched to 100%.
 */
export function homeStepMatch(call: ServiceCall, data: Record<string, unknown> = {}): string {
  const tail = Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
  return `${call.domain}.${call.service} ${call.entityId}${tail}`;
}

/**
 * For src/workorder.ts: is a home_assistant step one no plan may carry? Read
 * from the step's own match string, without the network, so a plan is refused
 * at the card that would have approved it rather than when the step runs.
 */
export function homeStepIsSecurity(match: string): boolean {
  const m = /^\s*([a-z0-9_]+)\.([a-z0-9_]+)\s+([a-z0-9_]+\.[a-z0-9_]+)/.exec(String(match ?? ""));
  // A match that cannot be read is not a covered step anyway; refusing it
  // here costs nothing and says so on the plan card.
  if (!m) return true;
  const call = { domain: m[1], service: m[2], entityId: m[3] };
  // At plan time there are no facts. A cover is judged by its name only here —
  // a plain blind may be planned — because the run itself reclassifies with
  // the device class and asks again if it turns out to be a door.
  const facts = call.domain === "cover" ? {} : undefined;
  return classifyHomeAction(call, facts).cls === "security";
}
