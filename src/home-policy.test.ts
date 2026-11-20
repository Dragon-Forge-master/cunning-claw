import assert from "node:assert/strict";
import test from "node:test";
import { classifyHomeAction, homeStepIsSecurity, homeStepMatch, validateCall } from "./home-policy.js";
import * as workorder from "./workorder.js";

/**
 * The home allow-list and the comfort/security split, with no network. The
 * same policy is exercised end to end through executeTool in home.test.ts.
 */

const call = (domain: string, service: string, entityId: string, data?: unknown) => ({ domain, service, entityId, data });

test("service data is passed for the calls that need it, cleaned and in range", () => {
  const light = validateCall(call("light", "turn_on", "light.kitchen", { brightness_pct: 40, color_temp_kelvin: 2700, transition: 2 }));
  assert.deepEqual(light, { ok: true, data: { brightness_pct: 40, color_temp_kelvin: 2700, transition: 2 } });
  const rgb = validateCall(call("light", "turn_on", "light.desk", { rgb_color: [255, 120, 0] }));
  assert.ok(rgb.ok);
  const heat = validateCall(call("climate", "set_temperature", "climate.living_room", { temperature: "20.5", hvac_mode: "heat" }));
  assert.deepEqual(heat, { ok: true, data: { temperature: 20.5, hvac_mode: "heat" } }, "a decimal string is read as the number");
  assert.ok(validateCall(call("cover", "set_cover_position", "cover.lounge_blind", { position: 30 })).ok);
  assert.ok(validateCall(call("media_player", "volume_set", "media_player.kitchen", { volume_level: 0.25 })).ok);
  assert.ok(validateCall(call("fan", "set_percentage", "fan.bedroom", { percentage: 50 })).ok);
  assert.deepEqual(validateCall(call("scene", "turn_on", "scene.goodnight")), { ok: true, data: {} });
});

test("an unknown key is refused with the list of keys the service takes", () => {
  const r = validateCall(call("light", "turn_on", "light.kitchen", { brightness: 200 }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /does not take "brightness"/);
  assert.match(r.error, /brightness_pct \(0–100%\)/, "the refusal teaches the right key and its range");
  assert.match(r.error, /color_temp_kelvin/);
  const scene = validateCall(call("scene", "turn_on", "scene.goodnight", { transition: 3 }));
  assert.equal(scene.ok, false, "scenes take no data");
});

test("values out of range are refused: heating 5–30 °C, a fixed set of HVAC modes, 0–100 positions", () => {
  for (const bad of [
    call("climate", "set_temperature", "climate.hall", { temperature: 45 }),
    call("climate", "set_temperature", "climate.hall", { temperature: 2 }),
    call("climate", "set_temperature", "climate.hall", {}),
    call("climate", "set_hvac_mode", "climate.hall", { hvac_mode: "sauna" }),
    call("light", "turn_on", "light.kitchen", { brightness_pct: 140 }),
    call("light", "turn_on", "light.kitchen", { rgb_color: [300, 0, 0] }),
    call("cover", "set_cover_position", "cover.blind", { position: -5 }),
    call("media_player", "volume_set", "media_player.kitchen", { volume_level: 3 }),
    call("fan", "set_percentage", "fan.bedroom", { percentage: 50.5 }),
  ]) {
    assert.equal(validateCall(bad).ok, false, `${bad.domain}.${bad.service} ${JSON.stringify(bad.data)}`);
  }
});

test("data cannot retarget the call: entity_id, area_id and codes are refused by name", () => {
  // haCall spread the data over the target, so this swapped the lamp on the
  // card for the lock behind it.
  const swap = validateCall(call("light", "turn_on", "light.kitchen", { entity_id: "lock.front_door" }));
  assert.equal(swap.ok, false);
  if (!swap.ok) assert.match(swap.error, /target is entityId/);
  assert.equal(validateCall(call("light", "turn_on", "light.kitchen", { area_id: "house" })).ok, false);
  const code = validateCall(call("alarm_control_panel", "alarm_disarm", "alarm_control_panel.home", { code: "1234" }));
  assert.equal(code.ok, false);
  if (!code.ok) assert.match(code.error, /never passed through the claw/);
});

test("the service's domain must be the entity's own, and the id one plain entity", () => {
  const cross = validateCall(call("light", "turn_on", "lock.front_door"));
  assert.equal(cross.ok, false, "light.turn_on aimed at a lock");
  assert.equal(validateCall(call("homeassistant", "turn_off", "alarm_control_panel.home")).ok, false);
  assert.equal(validateCall(call("light", "turn_on", "light.a, light.b")).ok, false);
  assert.equal(validateCall(call("light", "turn_on", "all")).ok, false);
  assert.equal(validateCall(call("light/../hassio", "turn_on", "light.a")).ok, false, "path parts are plain names");
});

test("administration, shells and messages to third parties are refused whatever the service", () => {
  for (const [d, s] of [["homeassistant", "restart"], ["shell_command", "wipe"], ["notify", "mobile_app_phone"], ["tts", "speak"], ["hassio", "addon_stop"], ["camera", "snapshot"]]) {
    const r = validateCall(call(d, s, `${d}.x`));
    assert.equal(r.ok, false, `${d}.${s}`);
    if (!r.ok) assert.match(r.error, /^Refused/);
  }
  const unknown = validateCall(call("valve", "open_valve", "valve.water_main"));
  assert.equal(unknown.ok, false, "a domain not on the list is not callable");
});

test("security: unlocking, disarming, sirens, automations and garage doors; comfort: the rest", () => {
  const sec = (c: ReturnType<typeof call>, facts?: Parameters<typeof classifyHomeAction>[1]) => classifyHomeAction(c, facts).cls;
  assert.equal(sec(call("lock", "unlock", "lock.front_door")), "security");
  assert.equal(sec(call("lock", "open", "lock.front_door")), "security");
  assert.equal(sec(call("lock", "lock", "lock.front_door")), "comfort", "locking closes the home");
  assert.equal(sec(call("alarm_control_panel", "alarm_disarm", "alarm_control_panel.home")), "security");
  assert.equal(sec(call("alarm_control_panel", "alarm_arm_away", "alarm_control_panel.home")), "security");
  assert.equal(sec(call("siren", "turn_off", "siren.hall")), "security");
  assert.equal(sec(call("automation", "turn_off", "automation.arm_at_night")), "security");
  assert.equal(sec(call("cover", "open_cover", "cover.garage"), { deviceClass: "garage" }), "security");
  assert.equal(sec(call("cover", "open_cover", "cover.drive"), { deviceClass: "gate" }), "security");
  assert.equal(sec(call("cover", "open_cover", "cover.unknown")), "security", "no device class read: assume a garage door");
  assert.equal(sec(call("cover", "open_cover", "cover.side"), { deviceClass: "", friendlyName: "Side gate" }), "security", "named a gate");
  assert.equal(sec(call("cover", "open_cover", "cover.lounge"), { deviceClass: "blind", friendlyName: "Lounge blind" }), "comfort");
  assert.equal(sec(call("switch", "turn_on", "switch.garage_opener")), "security");
  assert.equal(sec(call("button", "press", "button.front_door_buzzer")), "security");
  assert.equal(sec(call("script", "turn_on", "script.unlock_back_door")), "security");
  assert.equal(sec(call("scene", "turn_on", "scene.arrival"), { members: ["light.hall", "lock.front_door"] }), "security", "a scene with a lock in it");
  assert.equal(sec(call("switch", "turn_on", "switch.outdoor_lights")), "comfort", "outdoor is not a door");
  assert.equal(sec(call("light", "turn_on", "light.front_door_porch")), "comfort", "a light by the door is still a light");
  assert.equal(sec(call("climate", "set_temperature", "climate.hall")), "comfort");
  assert.equal(sec(call("scene", "turn_on", "scene.goodnight"), { members: ["light.hall", "light.landing"] }), "comfort");
});

test("a work order can carry a comfort step but never a security one", () => {
  const notDenied = () => false;
  const comfort = workorder.prepare("Evening", [
    { tool: "home_assistant", match: homeStepMatch(call("light", "turn_on", "light.lounge"), { brightness_pct: 30 }), summary: "Lounge lamp to 30%" },
    { tool: "home_assistant", match: "cover.close_cover cover.lounge_blind", summary: "Close the lounge blind" },
  ], notDenied);
  assert.ok(comfort.ok, "comfort steps may be planned");
  for (const match of ["lock.unlock lock.front_door", "alarm_control_panel.alarm_disarm alarm_control_panel.home", "cover.open_cover cover.garage_door", "switch.turn_on switch.gate_opener", "nonsense"]) {
    const r = workorder.prepare("Arrival", [
      { tool: "home_assistant", match: "light.turn_on light.hall", summary: "Hall light" },
      { tool: "home_assistant", match, summary: "and this" },
    ], notDenied);
    assert.equal(r.ok, false, match);
    if (!r.ok) assert.match(r.error, /Refused/);
    assert.equal(homeStepIsSecurity(match), true);
  }
});
