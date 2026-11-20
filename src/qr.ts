/**
 * A QR code encoder, byte mode only, for the HUD's "Pair a phone" card.
 *
 * Written here rather than installed because the dependency count is a rule
 * (two), and because a pairing code is a secret: the QR is drawn on this
 * machine's glass from a matrix this module computes, so the code never goes
 * to an image service or a CDN library. Byte mode covers every URL; the
 * numeric, alphanumeric and kanji modes would only make some codes smaller.
 *
 * The algorithm is ISO/IEC 18004: pick the smallest version that holds the
 * data, Reed-Solomon over GF(256), interleave the blocks, lay the codewords in
 * the zigzag, then try all eight masks and keep the one with the lowest
 * penalty. The structure follows Project Nayuki's public-domain-style
 * reference closely, because a QR encoder that is clever is a QR encoder that
 * phones cannot read. Tested against the standard's own vectors and against
 * matrices from an independent encoder (src/qr.test.ts).
 */

export type Ecl = "L" | "M" | "Q" | "H";

export interface QrCode {
  version: number;
  size: number;
  ecl: Ecl;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

/** The two bits the format information carries for each level (not the ordinal). */
const ECL_FORMAT_BITS: Record<Ecl, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_INDEX: Record<Ecl, number> = { L: 0, M: 1, Q: 2, H: 3 };

// ISO/IEC 18004 table 9, by level then version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules left for data and error correction once the function patterns are drawn. */
export function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (bytes) a version and level hold, before mode and length headers. */
export function dataCodewords(ver: number, ecl: Ecl): number {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

/** How many bytes of byte-mode payload fit: 4 mode bits and an 8- or 16-bit count. */
export function byteCapacity(ver: number, ecl: Ecl): number {
  const countBits = ver <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(ver, ecl) * 8 - 4 - countBits) / 8);
}

/** Centre coordinates of the alignment patterns, the same list for rows and columns. */
export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// --- Reed-Solomon over GF(2^8), primitive polynomial x^8+x^4+x^3+x^2+1 -------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial's coefficients, highest power first, leading 1 dropped. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for one block. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}

// --- Format and version information -------------------------------------------

/** The 15 format bits (BCH(15,5), masked with 0x5412) for a level and mask. */
export function formatBits(ecl: Ecl, mask: number): number {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (BCH(18,6)) carried by versions 7 and up. */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

// --- Encoding -----------------------------------------------------------------

/** Mode, count, payload, terminator, padding: the data codewords before RS. */
export function dataCodewordsFor(bytes: Uint8Array, ver: number, ecl: Ecl): number[] {
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacityBits = dataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

/** Split into blocks, append each block's EC, and interleave as the symbol reads them. */
export function interleave(data: readonly number[], ver: number, ecl: Ecl): number[] {
  const e = ECL_INDEX[ecl];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const ecLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - ecLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ec = reedSolomon(dat, ecLen);
    // A short block gets a placeholder so every block indexes alike; it is skipped below.
    if (i < numShortBlocks) dat.push(-1);
    blocks.push([...dat, ...ec]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (const b of blocks) if (b[i] !== -1) out.push(b[i]);
  }
  return out;
}

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  fn(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFormat(g: Grid, ecl: Ecl, mask: number): void {
  const bits = formatBits(ecl, mask);
  for (let i = 0; i <= 5; i++) g.fn(8, i, bit(bits, i));
  g.fn(8, 7, bit(bits, 6));
  g.fn(8, 8, bit(bits, 7));
  g.fn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.fn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) g.fn(g.size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.fn(8, g.size - 15 + i, bit(bits, i));
  g.fn(8, g.size - 8, true); // the dark module, always set
}

function drawFunctionPatterns(g: Grid, ver: number, ecl: Ecl): void {
  for (let i = 0; i < g.size; i++) {
    g.fn(6, i, i % 2 === 0);
    g.fn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [g.size - 4, 3], [3, g.size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        g.fn(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver);
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // The three corners already hold finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.fn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Reserve the format areas now; the real bits go in once the mask is chosen.
  drawFormat(g, ecl, 0);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const a = g.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.fn(a, b, bit(bits, i));
      g.fn(b, a, bit(bits, i));
    }
  }
}

function drawCodewords(g: Grid, data: readonly number[]): void {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped whole
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (!g.isFunction[y][x] && i < data.length * 8) {
          g.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  const m = MASKS[mask];
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) if (!g.isFunction[y][x] && m(x, y)) g.modules[y][x] = !g.modules[y][x];
  }
}

/**
 * The standard's four penalty rules. Any mask makes a readable symbol; the
 * penalty only steers away from ones a camera finds hard (long runs, blocks,
 * shapes that look like a finder pattern, too much ink or too little).
 */
export function penalty(modules: readonly boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(modules[y].slice());
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));
  const finderA = [true, false, true, true, true, false, true, false, false, false, false];
  const finderB = [false, false, false, false, true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= size; i++) {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k++) {
        if (line[i + k] !== finderA[k]) a = false;
        if (line[i + k] !== finderB[k]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

export class QrTooLong extends Error {}

/**
 * Encode text (UTF-8, byte mode) as the smallest symbol that holds it at the
 * given level. `mask` forces one of the eight masks, for tests; left out, the
 * lowest-penalty mask is chosen as the standard says.
 */
export function encodeQr(text: string, opts: { ecl?: Ecl; mask?: number; minVersion?: number } = {}): QrCode {
  const ecl = opts.ecl ?? "M";
  const bytes = new TextEncoder().encode(text);
  let ver = Math.max(1, Math.min(40, opts.minVersion ?? 1));
  while (byteCapacity(ver, ecl) < bytes.length) {
    if (++ver > 40) throw new QrTooLong(`${bytes.length} bytes is more than a QR code holds at level ${ecl}`);
  }
  const codewords = interleave(dataCodewordsFor(bytes, ver, ecl), ver, ecl);
  const build = (mask: number): Grid => {
    const g = new Grid(ver * 4 + 17);
    drawFunctionPatterns(g, ver, ecl);
    drawCodewords(g, codewords);
    applyMask(g, mask);
    drawFormat(g, ecl, mask);
    return g;
  };
  let mask = opts.mask ?? -1;
  if (mask < 0 || mask > 7) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      const p = penalty(build(m).modules);
      if (p < best) { best = p; mask = m; }
    }
  }
  const g = build(mask);
  return { version: ver, size: g.size, ecl, mask, modules: g.modules };
}

/** Rows as "0"/"1" strings — compact for JSON, and what the HUD draws from. */
export function qrRows(code: QrCode): string[] {
  return code.modules.map((row) => row.map((m) => (m ? "1" : "0")).join(""));
}
