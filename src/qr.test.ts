import assert from "node:assert/strict";
import test from "node:test";
import {
  alignmentPositions,
  byteCapacity,
  encodeQr,
  formatBits,
  qrRows,
  QrTooLong,
  reedSolomon,
  versionBits,
  type Ecl,
} from "./qr.js";

/**
 * The pairing QR is drawn from this encoder and nothing else, so a phone that
 * cannot read it means a phone that cannot pair. These are the standard's own
 * numbers, plus whole symbols from an independent encoder.
 */

test("Reed-Solomon matches ISO/IEC 18004 Annex I (01234567, 1-M)", () => {
  const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
});

test("Reed-Solomon matches the HELLO WORLD 1-M worked example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format bits match the standard's table for each level at mask 0, and a mid-table entry", () => {
  const want: Record<Ecl, string> = {
    L: "111011111000100",
    M: "101010000010010",
    Q: "011010101011111",
    H: "001011010001001",
  };
  for (const [ecl, bits] of Object.entries(want) as [Ecl, string][]) {
    assert.equal(formatBits(ecl, 0).toString(2).padStart(15, "0"), bits, `level ${ecl}`);
  }
  assert.equal(formatBits("M", 5).toString(2).padStart(15, "0"), "100000011001110");
});

test("version bits match the standard's table (7, 21, 40)", () => {
  assert.equal(versionBits(7).toString(2).padStart(18, "0"), "000111110010010100");
  assert.equal(versionBits(21).toString(2).padStart(18, "0"), "010101011010000011");
  assert.equal(versionBits(40).toString(2).padStart(18, "0"), "101000110001101001");
});

test("byte capacities match ISO/IEC 18004 table 7", () => {
  const table: [number, number, number, number, number][] = [
    [1, 17, 14, 11, 7], [2, 32, 26, 20, 14], [3, 53, 42, 32, 24], [4, 78, 62, 46, 34],
    [5, 106, 84, 60, 44], [6, 134, 106, 74, 58], [7, 154, 122, 86, 64], [8, 192, 152, 108, 84],
    [9, 230, 180, 130, 98], [10, 271, 213, 151, 119], [20, 858, 666, 482, 382],
    [27, 1465, 1125, 805, 625], [40, 2953, 2331, 1663, 1273],
  ];
  for (const [v, l, m, q, h] of table) {
    assert.deepEqual([byteCapacity(v, "L"), byteCapacity(v, "M"), byteCapacity(v, "Q"), byteCapacity(v, "H")], [l, m, q, h], `version ${v}`);
  }
});

test("alignment pattern centres match the standard's table", () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(36), [6, 24, 50, 76, 102, 128, 154]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

/**
 * Whole symbols from Project Nayuki's qrcodegen (Python, 1.8) with the same
 * level and mask forced, one row per hex number. Between them they cover a
 * pairing-URL-shaped text, two blocks, and a version 8 symbol, which carries
 * the version information blocks.
 */
const VECTORS: { t: string; ecl: Ecl; mask: number; version: number; rows: string }[] = [
  {
    t: "https://pocket.example.ts.net/pocket/#pair=abc", ecl: "M", mask: 2, version: 4,
    rows: "1fce8fe7f,1044e8041,1755bd85d,17587355d,175aa4a5d,1052f1c41,1fd55557f,1e60900,17c8fc17c,1dbf57a6d,9fe34016,f1770f1f,1bfc24b98,1f23f9243,65a0a4da,1994d78ec,6f94b7b1,d139b2ed,ae029436,53cdd3bf,1a5053cbb,1f24a4b6d,14fbf1d1e,178ba4f1d,11e4a85fb,1a53d15,1fc4e5b56,105c50f1c,175dc49f8,1754f169d,175ecea64,1044d3a54,1fdece7a2",
  },
  {
    t: "Cunning Claw", ecl: "Q", mask: 5, version: 2,
    rows: "1fdbe7f,105d241,174e55d,174065d,1742e5d,1045d41,1fd557f,f800,877683,1b29438,bf10bf,68274b,ce3c79,1bbac2e,17c0b4f,16205de,10dfbfd,10115,1fd9755,1049b19,17411fe,1743cc9,174e18d,10518f9,1fc2719",
  },
  {
    t: "x".repeat(160), ecl: "L", mask: 0, version: 8,
    rows: "1fc2bbdddd17f,1040667777f41,175e00522235d,174d44188825d,174f557ddd85d,104fccc777441,1fd555555557f,11aac5ddf00,1dfeeeff776c4,59944f22202d,14db556888987,1a25331dddfd2,2e255b777678,138e11622202d,1858000888987,1c32996dddfd2,125aee5777678,29c44e22202d,15c994888987,1322ff1dddfd2,1d8bbb777678,aaaa22202d,19fb337c889f7,1b1caa45ddf12,d58ee5777558,f1744c62211d,5f0557c88bf7,10bc3375ddd72,1172556377528,835118a2228d,18c9009c88ad7,93b9975ddd72,127eeea377528,17a8440a2228d,1861991c88ad7,89eff35ddd72,1f4bbb6377528,592aa8a2228d,8f3339c88ad7,e26aaf5ddd72,1c42ee7f775f9,1044c62231d,1fd155d488957,105733c5ddf12,1751557f777f8,1745111e221df,1750003488b74,105d99a1dde22,1fdaeecb7748b",
  },
];

for (const v of VECTORS) {
  test(`a whole ${v.version}-${v.ecl} symbol, mask ${v.mask}, matches an independent encoder module for module`, () => {
    const code = encodeQr(v.t, { ecl: v.ecl, mask: v.mask });
    assert.equal(code.version, v.version);
    const size = code.size;
    const want = v.rows.split(",").map((h) => BigInt(`0x${h}`).toString(2).padStart(size, "0"));
    assert.deepEqual(qrRows(code), want);
  });
}

test("a pairing URL fits a small symbol at level M, and the mask is chosen, not defaulted", () => {
  const url = "https://claw-desk.tail1a2b3c.ts.net/pocket/#pair=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
  const code = encodeQr(url);
  assert.ok(code.version <= 6, `version ${code.version} is larger than a phone camera likes`);
  assert.equal(code.size, code.version * 4 + 17);
  assert.ok(code.mask >= 0 && code.mask <= 7);
  // Finder patterns in all three corners: the top-left 7x7 has a dark ring and a dark core.
  const r = qrRows(code);
  assert.equal(r[0].slice(0, 7), "1111111");
  assert.equal(r[3].slice(0, 7), "1011101");
  assert.equal(r[0].slice(-7), "1111111");
  assert.equal(r[code.size - 1].slice(0, 7), "1111111");
});

test("text longer than any symbol holds is refused, not truncated", () => {
  assert.throws(() => encodeQr("x".repeat(2954), { ecl: "L" }), QrTooLong);
  assert.doesNotThrow(() => encodeQr("x".repeat(2953), { ecl: "L" }));
});
