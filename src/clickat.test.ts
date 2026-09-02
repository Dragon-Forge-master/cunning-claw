import assert from "node:assert/strict";
import test from "node:test";
import { clickAt, lastShotGeometry } from "./desktop.js";

/**
 * Cunning Claw had worked the screen-to-image scale out by hand and written it
 * into its own memory: "screen is 1920x1080, screenshot is 1400x788, so
 * screen_xy = image_xy * 1.3714". That works until the resolution changes and
 * the remembered number is silently wrong — every click then lands somewhere
 * plausible and incorrect. The conversion belongs where both sizes are known.
 */

test("clicking before any screenshot says so rather than guessing", async () => {
  if (lastShotGeometry()) return; // a capture happened in another test run
  const out = await clickAt(100, 100);
  assert.match(out, /screenshot/i, "must explain what is missing");
  assert.doesNotMatch(out, /Clicked/, "must not claim a click happened");
});

test("a coordinate off the image is refused, not clamped", async () => {
  const geo = lastShotGeometry();
  if (!geo) return;
  const out = await clickAt(geo.imageW * 5, geo.imageH * 5);
  assert.match(out, /off a/, "a click far outside the screen is a mistake, not a corner click");
});
