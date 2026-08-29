/**
 * Jurisdiction packs — the law we will stand behind.
 *
 * Books (Xero, Sage, a spreadsheet) are the numbers. These files are the
 * country. Inventing a French TVA rate because someone asked in French is how
 * an accountant gets struck off. Missing pack → say so.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT } from "./config.js";

export const TAX_DIR = path.join(ROOT, "workspace", "tax");
const STATE_FILE = path.join(DATA_DIR, "tax.json");

export type TaxFact = { key: string; value: string; note?: string };

export type TaxTopic = {
  summary: string;
  facts: TaxFact[];
};

export type TaxPack = {
  id: string;
  name: string;
  authority: string;
  currency: string;
  asOf: string;
  sources: string[];
  taxYear: { label: string; startMonth: number; startDay: number };
  topics: Record<string, TaxTopic>;
};

type TaxState = { jurisdiction: string };

const ALIASES: Record<string, string> = {
  uk: "uk",
  gb: "uk",
  "great britain": "uk",
  britain: "uk",
  england: "uk",
  wales: "uk",
  scotland: "uk",
  "northern ireland": "uk",
  "united kingdom": "uk",
  ie: "ie",
  ireland: "ie",
  eire: "ie",
  us: "us",
  usa: "us",
  "united states": "us",
  america: "us",
  au: "au",
  australia: "au",
  de: "de",
  germany: "de",
  deutschland: "de",
};

export function resolveJurisdictionId(raw?: string): string | null {
  const q = String(raw ?? "").trim().toLowerCase();
  if (!q) return null;
  if (ALIASES[q]) return ALIASES[q];
  if (/^[a-z]{2}$/.test(q) && packExists(q)) return q;
  const packs = listPacks();
  const hit = packs.find(
    (p) => p.id === q || p.name.toLowerCase() === q || p.name.toLowerCase().includes(q),
  );
  return hit?.id ?? null;
}

function readIndexDefault(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(TAX_DIR, "index.json"), "utf-8"));
    return String(raw.default ?? "uk");
  } catch {
    return "uk";
  }
}

function loadState(): TaxState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as TaxState;
    if (raw?.jurisdiction && packExists(raw.jurisdiction)) return raw;
  } catch { /* first run */ }
  return { jurisdiction: readIndexDefault() };
}

function saveState(state: TaxState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function packExists(id: string): boolean {
  return fs.existsSync(path.join(TAX_DIR, `${id}.json`));
}

export function loadPack(id: string): TaxPack | null {
  const file = path.join(TAX_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const pack = JSON.parse(fs.readFileSync(file, "utf-8")) as TaxPack;
    if (!pack?.id || !pack.topics) return null;
    return pack;
  } catch {
    return null;
  }
}

export function listPacks(): TaxPack[] {
  if (!fs.existsSync(TAX_DIR)) return [];
  return fs.readdirSync(TAX_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => loadPack(f.replace(/\.json$/, "")))
    .filter((p): p is TaxPack => p != null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function currentJurisdiction(): string {
  return loadState().jurisdiction;
}

export function setJurisdiction(raw: string): { ok: true; pack: TaxPack } | { ok: false; message: string } {
  const id = resolveJurisdictionId(raw);
  if (!id) {
    const known = listPacks().map((p) => `${p.id} (${p.name})`).join(", ");
    return {
      ok: false,
      message:
        `No tax pack for ${JSON.stringify(raw)}. I will not invent rates for a country I do not have. ` +
        `Shipped packs: ${known || "(none)"}. Drop workspace/tax/<id>.json to add one.`,
    };
  }
  const pack = loadPack(id);
  if (!pack) return { ok: false, message: `Pack "${id}" is unreadable.` };
  saveState({ jurisdiction: id });
  return { ok: true, pack };
}

/** UK-style 2026/27 label from a pack's tax-year start and a date. */
export function taxYearLabel(pack: TaxPack, when = new Date()): string {
  const y = when.getUTCFullYear();
  const start = Date.UTC(y, pack.taxYear.startMonth - 1, pack.taxYear.startDay);
  const inYear = when.getTime() >= start ? y : y - 1;
  if (pack.taxYear.startMonth === 1 && pack.taxYear.startDay === 1) return String(inYear);
  return `${inYear}/${String(inYear + 1).slice(-2)}`;
}

export function formatPackList(active: string): string {
  const rows = listPacks().map((p) => {
    const mark = p.id === active ? " *" : "";
    const topics = Object.keys(p.topics).join(", ");
    return `[${p.id}]${mark} ${p.name} — ${p.authority} · ${p.currency} · as of ${p.asOf}\n    topics: ${topics}`;
  });
  return [
    `Active jurisdiction: ${active}`,
    "Books (Xero, Sage, a spreadsheet) are the numbers. These packs are the country.",
    "A missing country is a missing file, not a guess.",
    "",
    rows.join("\n") || "(no packs in workspace/tax)",
  ].join("\n");
}

export function formatTopic(pack: TaxPack, topicId: string, topic: TaxTopic): string {
  const facts = topic.facts.map((f) => `- ${f.key}: ${f.value}${f.note ? ` — ${f.note}` : ""}`);
  return [
    `${pack.name} / ${topicId}  (tax year ${taxYearLabel(pack)}, pack dated ${pack.asOf})`,
    `Authority: ${pack.authority}`,
    "",
    topic.summary,
    "",
    ...facts,
    "",
    `Sources: ${pack.sources.join(" · ")}`,
    "This is a packed fact sheet, not a filing. Verify on the authority site before money moves.",
  ].join("\n");
}

export function formatUnknownTopic(pack: TaxPack, want: string): string {
  const topics = Object.keys(pack.topics).join(", ");
  return [
    `${pack.name} has no packed topic ${JSON.stringify(want)}.`,
    `I will not invent one. Packed topics: ${topics || "(none)"}.`,
    `Authority: ${pack.authority}. Sources: ${pack.sources.join(" · ")}.`,
  ].join("\n");
}

export function taxStatusText(): string {
  const id = currentJurisdiction();
  const pack = loadPack(id);
  if (!pack) return formatPackList(id);
  return [
    formatPackList(id),
    "",
    `Current tax year (${pack.id}): ${taxYearLabel(pack)} (${pack.taxYear.label}).`,
  ].join("\n");
}

export function taxSetText(raw: string): string {
  const result = setJurisdiction(raw);
  if (!result.ok) return result.message;
  return `Jurisdiction is now ${result.pack.id} (${result.pack.name}). Tax year ${taxYearLabel(result.pack)}. ${taxStatusText()}`;
}

export function taxLookupText(opts: { jurisdiction?: string; topic?: string }): string {
  let id = currentJurisdiction();
  if (opts.jurisdiction) {
    const resolved = resolveJurisdictionId(opts.jurisdiction);
    if (!resolved) {
      const fail = setJurisdiction(opts.jurisdiction);
      return fail.ok ? "" : fail.message;
    }
    id = resolved;
  }
  const pack = loadPack(id);
  if (!pack) {
    return `No pack for "${id}". I will not invent ${opts.jurisdiction || id} tax. ${formatPackList(currentJurisdiction())}`;
  }
  const topic = String(opts.topic ?? "").trim().toLowerCase();
  if (!topic) {
    const heads = Object.entries(pack.topics).map(([k, t]) => `[${k}] ${t.summary}`);
    return [
      `${pack.name} (${pack.id}) — ${pack.authority} · ${pack.currency} · as of ${pack.asOf}`,
      `Tax year: ${taxYearLabel(pack)} (${pack.taxYear.label})`,
      "",
      ...heads,
      "",
      `Pass topic (${Object.keys(pack.topics).join(", ")}) for the fact sheet.`,
      `Sources: ${pack.sources.join(" · ")}`,
    ].join("\n");
  }
  const aliases: Record<string, string> = {
    gst: "gst",
    vat: "vat",
    "sales-tax": "sales-tax",
    salestax: "sales-tax",
    paye: "payroll",
    payroll: "payroll",
    wages: "payroll",
    "self assessment": "self-assessment",
    selfassessment: "self-assessment",
    "corporation tax": "corporation-tax",
    "income tax": "income-tax",
    incometax: "income-tax",
  };
  const key = pack.topics[topic] ? topic : aliases[topic];
  const hit = key ? pack.topics[key] : undefined;
  if (!hit) return formatUnknownTopic(pack, topic);
  return formatTopic(pack, key!, hit);
}
