import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export type LandscapeSystem = {
  id: string;
  name: string;
  url: string;
  class: string;
  take: string;
  refuse: string;
};

export type Landscape = {
  updated: string;
  note: string;
  systems: LandscapeSystem[];
};

export function loadLandscape(): Landscape {
  const file = path.join(ROOT, "docs", "landscape.json");
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Landscape;
}

export function landscapeSummary(): string {
  const data = loadLandscape();
  const lines = [
    `Field map updated ${data.updated}. ${data.systems.length} systems tracked.`,
    data.note,
    ...data.systems.map((s) => `- ${s.name} [${s.class}] — take: ${s.take}`),
  ];
  return lines.join("\n");
}
