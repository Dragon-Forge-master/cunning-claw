import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveJurisdictionId,
  loadPack,
  listPacks,
  taxYearLabel,
  taxLookupText,
  taxSetText,
  formatUnknownTopic,
} from "./tax.js";
import { toolDefinitions } from "./tools.js";

test("aliases land on a shipped pack — Wales is UK, not a guess at a Welsh rate", () => {
  assert.equal(resolveJurisdictionId("Wales"), "uk");
  assert.equal(resolveJurisdictionId("united kingdom"), "uk");
  assert.equal(resolveJurisdictionId("eire"), "ie");
  assert.equal(resolveJurisdictionId("usa"), "us");
  assert.equal(resolveJurisdictionId("deutschland"), "de");
  assert.equal(resolveJurisdictionId("france"), null);
});

test("every shipped pack has an authority, a date, and sources — no anonymous rates", () => {
  const packs = listPacks();
  assert.ok(packs.some((p) => p.id === "uk"));
  for (const p of packs) {
    assert.ok(p.authority, p.id);
    assert.ok(p.asOf, p.id);
    assert.ok(p.sources.length, p.id);
    assert.ok(Object.keys(p.topics).length, p.id);
  }
});

test("UK VAT names the 20% standard rate and refuses to treat the threshold as gospel", () => {
  const text = taxLookupText({ jurisdiction: "uk", topic: "vat" });
  assert.match(text, /20%/);
  assert.match(text, /HMRC/);
  assert.match(text, /GOV\.UK|gov\.uk/);
  assert.match(text, /margin scheme|second-hand/i);
});

test("a country we do not pack is a refusal, not a hallucination", () => {
  const text = taxLookupText({ jurisdiction: "france", topic: "vat" });
  assert.match(text, /will not invent/i);
  assert.match(text, /uk \(United Kingdom\)/i);
});

test("an unknown topic on a known pack lists what we actually have", () => {
  const pack = loadPack("uk");
  assert.ok(pack);
  const text = formatUnknownTopic(pack!, "wealth-tax");
  assert.match(text, /will not invent/);
  assert.match(text, /vat/);
});

test("UK tax year rolls on 6 April", () => {
  const pack = loadPack("uk")!;
  assert.equal(taxYearLabel(pack, new Date("2026-04-05T12:00:00Z")), "2025/26");
  assert.equal(taxYearLabel(pack, new Date("2026-04-06T12:00:00Z")), "2026/27");
});

test("calendar-year packs label the year plainly", () => {
  const pack = loadPack("us")!;
  assert.equal(taxYearLabel(pack, new Date("2026-03-01T12:00:00Z")), "2026");
});

test("setting Ireland sticks, and payroll there is not UK PAYE", () => {
  const set = taxSetText("ireland");
  assert.match(set, /Jurisdiction is now ie/);
  const pay = taxLookupText({ topic: "payroll" });
  assert.match(pay, /USC|PRSI|Revenue/);
  taxSetText("uk");
});

test("tax tools are on the roster", () => {
  const names = toolDefinitions.map((t) => t.name);
  assert.ok(names.includes("tax_jurisdiction"));
  assert.ok(names.includes("tax_lookup"));
});
