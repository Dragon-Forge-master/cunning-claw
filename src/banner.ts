/**
 * Terminal boot banner.
 *
 * Printed on startup and by the setup scripts. Degrades to plain text when
 * colour is unwanted (NO_COLOR, a pipe, a dumb terminal) so it never dumps
 * escape codes into a log file.
 */

/** Three talons closing on a point — ours, rather than a borrowed reactor. */
const MARK = [
  "  ▟█▙   ▟█▙   ▟█▙  ",
  "  ▜██▙ ▟███▙ ▟██▛  ",
  "   ▜██▄███████▄██▛ ",
  "    ▀████▀ ▀████▀  ",
  "      ▜██▄▄▄██▛    ",
  "        ▜███▛      ",
  "         ▜▛        ",
  "          ▀        ",
];

const WORDMARK = [
  " ██████╗██╗      █████╗ ██╗    ██╗",
  "██╔════╝██║     ██╔══██╗██║    ██║",
  "██║     ██║     ███████║██║ █╗ ██║",
  "██║     ██║     ██╔══██║██║███╗██║",
  "╚██████╗███████╗██║  ██║╚███╔███╔╝",
  " ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
];

/** Cyan ramp, dim at the edges and bright at the core. */
const RAMP = [24, 31, 38, 45, 51, 87, 123, 159];

function useColour(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

function paint(text: string, colour: number, colour_: boolean): string {
  return colour_ ? `\x1b[38;5;${colour}m${text}\x1b[0m` : text;
}

export interface BannerInfo {
  version: string;
  url: string;
  brain?: string;
  voice?: string;
  heartbeat?: string;
  tools?: number;
}

export function banner(info: BannerInfo): string {
  const c = useColour();
  const out: string[] = [""];

  // Brightest through the middle, so the talons appear to catch the light.
  const height = Math.max(MARK.length, WORDMARK.length);
  const padTop = Math.floor((height - WORDMARK.length) / 2);

  for (let i = 0; i < height; i++) {
    const distance = Math.abs(i - (MARK.length - 1) / 2);
    const markColour = RAMP[Math.max(0, RAMP.length - 1 - Math.round(distance * 1.6))];
    const left = MARK[i] ?? " ".repeat(19);

    const wordIndex = i - padTop;
    const right = WORDMARK[wordIndex] ?? "";
    const wordColour = RAMP[Math.min(RAMP.length - 1, 3 + wordIndex)] ?? 51;

    out.push("  " + paint(left, markColour, c) + "  " + paint(right, wordColour, c));
  }

  const dim = (s: string) => paint(s, 24, c);
  const lit = (s: string) => paint(s, 51, c);

  out.push("");
  out.push("  " + dim("──────────────────────────────────────────────────────────────"));
  out.push("  " + dim("CUNNING CLAW") + dim("  ·  dyn hysbys  ·  v") + dim(info.version));
  out.push("");
  out.push("  " + lit("▸") + " online   " + lit(info.url));
  if (info.brain) out.push("  " + dim("▸") + " brain    " + info.brain);
  if (info.voice) out.push("  " + dim("▸") + " voice    " + info.voice);
  if (info.heartbeat) out.push("  " + dim("▸") + " pulse    " + info.heartbeat);
  if (info.tools) out.push("  " + dim("▸") + " tools    " + String(info.tools) + " available");
  out.push("");
  out.push("  " + dim("At your service, sir."));
  out.push("");

  return out.join("\n");
}
