/**
 * Terminal boot banner.
 *
 * Printed on startup and by the setup scripts. Degrades to plain text when
 * colour is unwanted (NO_COLOR, a pipe, a dumb terminal) so it never dumps
 * escape codes into a log file.
 */

/**
 * The Forge Claw's ASCII kin: talons gripping the anvil, per the brand mark
 * (docs/assets/forge-mark.svg). Horn left, face wide, waist, base — with the
 * claw hooking over the face from above.
 */
const MARK = [
  "           ▗▄▄▟█▛▀▘ ",
  "       ▄▄▟██████▛   ",
  "     ▗▟█▛▘▜█▛▜██▖   ",
  "     ▝▜█▙ ▜█▖▝█▙▚   ",
  " ▄▄▄▄▄▄▟██▄▄██▄▄█▙▄ ",
  " ▀▀▜████████████▛▀▘ ",
  "     ▀▜████████▛▀   ",
  "       ▐██████▌     ",
  "     ▄▟████████▙▄   ",
  "     ▀▀▀▀▀▀▀▀▀▀▀▀   ",
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

/**
 * Arysgrif y dydd — the day's inscription. Real Welsh proverbs, one per day,
 * rotated deterministically so the same dawn shows every claw the same words.
 * Rules of the Swyn apply: genuine Welsh only, always glossed, all documented
 * in docs/SWYN.md. The magic is that every riddle checks out.
 */
const PROVERBS: [string, string][] = [
  ["Dyfal donc a dyr y garreg.", "Steady tapping breaks the stone."],
  ["Deuparth gwaith yw ei ddechrau.", "Starting is two-thirds of the work."],
  ["A fo ben, bid bont.", "Who would lead, let them be a bridge."],
  ["Gwell dysg na golud.", "Better learning than wealth."],
  ["Nid aur popeth melyn.", "Not everything yellow is gold."],
  ["Hir yw pob ymaros.", "All waiting is long."],
  ["Gwell hwyr na hwyrach.", "Better late than later."],
  ["Cenedl heb iaith, cenedl heb galon.", "A nation without a language is a nation without a heart."],
];

export function proverbOfTheDay(date = new Date()): [string, string] {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  return PROVERBS[dayOfYear % PROVERBS.length];
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
  out.push("  " + dim("CUNNING CLAW") + dim("  ·  y dyn hysbys  ·  v") + dim(info.version));
  out.push("  " + dim("Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau"));
  out.push("  " + dim("(local first · human consent where there are consequences)"));
  out.push("");
  out.push("  " + lit("▸") + " ar-lein  " + lit(info.url) + dim("   the glass is lit"));
  if (info.brain) out.push("  " + dim("▸") + " brain    " + info.brain);
  if (info.voice) out.push("  " + dim("▸") + " llais    " + info.voice + dim("   (the voice)"));
  if (info.heartbeat) out.push("  " + dim("▸") + " curiad   " + info.heartbeat + dim("   (the heartbeat)"));
  if (info.tools) out.push("  " + dim("▸") + " offer    " + String(info.tools) + " tools on the bench");
  out.push("");
  // The three wards. These are not decoration: each names a subsystem that is
  // unconditionally active — fenceUntrusted, the approval gate, the loop guard.
  // Print no ward that is not real.
  out.push("  " + dim("▸") + " wards    y ffens   " + dim("— outside words are fenced"));
  out.push("  " + dim("           ") + "y llw     " + dim("— consequences wait for you"));
  out.push("  " + dim("           ") + "y sarff   " + dim("— the serpent watches the loop"));
  out.push("");
  const [cymraeg, saesneg] = proverbOfTheDay();
  out.push("  " + lit("“" + cymraeg + "”"));
  out.push("  " + dim("  — " + saesneg + "  · arysgrif y dydd"));
  out.push("");
  out.push("  " + dim("At your service, sir."));
  out.push("");

  return out.join("\n");
}
