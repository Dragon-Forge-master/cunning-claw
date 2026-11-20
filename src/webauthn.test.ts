import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  decodeCbor,
  decodeCborAll,
  parseAuthData,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type RegisteredCredential,
} from "./webauthn.js";
import { encodeCbor, softAuthenticator, softCreate, softGet } from "./webauthn-soft.js";

/**
 * Approving a card from the phone is a consequence, so each of these is a way
 * an attacker would try to answer one without the owner's finger: a page on
 * another origin, a response recorded earlier, a phone that skipped the
 * biometric, a key that is not the enrolled one.
 */

const RP = "claw-desk.tail1a2b3c.ts.net";
const ORIGIN = `https://${RP}`;
const EXPECT = { origins: [ORIGIN], rpId: RP };
const challenge = () => crypto.randomBytes(32).toString("base64url");

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof WebAuthnError, `expected a WebAuthnError, got ${String(err)}`);
    return err.code;
  }
  return "accepted";
}

function enrol(alg: -7 | -257 = -7) {
  const auth = softAuthenticator(alg);
  const c = challenge();
  const reg = verifyRegistration(softCreate(auth, c, { origin: ORIGIN, rpId: RP }), { ...EXPECT, challenge: c });
  return { auth, reg };
}

const assertExpect = (reg: RegisteredCredential, c: string, signCount = reg.signCount) => ({
  ...EXPECT, challenge: c, credentialId: reg.credentialId, key: reg.key, signCount,
});

test("CBOR: integers, negatives, strings, bytes, arrays and maps decode as RFC 8949 Appendix A says", () => {
  const hex = (h: string) => decodeCborAll(Buffer.from(h, "hex"));
  assert.equal(hex("00"), 0);
  assert.equal(hex("1903e8"), 1000);
  assert.equal(hex("3863"), -100);
  assert.equal(hex("6449455446"), "IETF");
  assert.deepEqual(hex("4401020304"), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(hex("83010203"), [1, 2, 3]);
  assert.deepEqual(hex("a201020304"), new Map([[1, 2], [3, 4]]));
  assert.equal(hex("f4"), false);
  assert.equal(hex("f6"), null);
});

test("CBOR: indefinite lengths, truncation, repeated keys and trailing bytes are refused", () => {
  for (const h of ["5f42010243030405ff", "44010203", "a201020103", "0000"]) {
    assert.throws(() => decodeCborAll(Buffer.from(h, "hex")), WebAuthnError, h);
  }
  // A claimed length far past the buffer must not allocate or loop.
  assert.throws(() => decodeCbor(Buffer.from("9b00000000ffffffff", "hex")), WebAuthnError);
});

test("an ES256 platform credential registers and its first assertion verifies", () => {
  const { auth, reg } = enrol(-7);
  assert.equal(reg.key.alg, -7);
  const c = challenge();
  const out = verifyAssertion(softGet(auth, c, { origin: ORIGIN, rpId: RP }), assertExpect(reg, c));
  assert.equal(out.signCount, 1);
});

test("an RS256 credential registers and verifies too", () => {
  const { auth, reg } = enrol(-257);
  assert.equal(reg.key.alg, -257);
  const c = challenge();
  assert.doesNotThrow(() => verifyAssertion(softGet(auth, c, { origin: ORIGIN, rpId: RP }), assertExpect(reg, c)));
});

test("a packed self-attestation is accepted only when its signature verifies", () => {
  const auth = softAuthenticator();
  const c = challenge();
  const good = softCreate(auth, c, { origin: ORIGIN, rpId: RP }, "packed");
  assert.equal(code(() => verifyRegistration(good, { ...EXPECT, challenge: c })), "accepted");
  // Same object signed by a different key: forged.
  const other = softAuthenticator();
  other.credentialId = auth.credentialId;
  const forged = softCreate(auth, c, { origin: ORIGIN, rpId: RP }, "none");
  const signedByOther = softCreate(other, c, { origin: ORIGIN, rpId: RP }, "packed");
  const att = decodeCborAll(Buffer.from(signedByOther.response.attestationObject, "base64url")) as Map<any, any>;
  const mine = decodeCborAll(Buffer.from(forged.response.attestationObject, "base64url")) as Map<any, any>;
  att.set("authData", mine.get("authData"));
  forged.response.attestationObject = encodeCbor(att as any).toString("base64url");
  assert.equal(code(() => verifyRegistration(forged, { ...EXPECT, challenge: c })), "signature");
});

test("registration from the wrong origin is refused", () => {
  const auth = softAuthenticator();
  const c = challenge();
  const cred = softCreate(auth, c, { origin: "https://evil.example", rpId: RP });
  assert.equal(code(() => verifyRegistration(cred, { ...EXPECT, challenge: c })), "origin");
});

test("registration without user verification is refused — a tap is not a fingerprint", () => {
  const auth = softAuthenticator();
  const c = challenge();
  const cred = softCreate(auth, c, { origin: ORIGIN, rpId: RP, uv: false });
  assert.equal(code(() => verifyRegistration(cred, { ...EXPECT, challenge: c })), "uv");
});

test("registration for another relying party is refused", () => {
  const auth = softAuthenticator();
  const c = challenge();
  const cred = softCreate(auth, c, { origin: ORIGIN, rpId: "evil.example" });
  assert.equal(code(() => verifyRegistration(cred, { ...EXPECT, challenge: c })), "rpid");
});

test("an assertion from the wrong origin is refused", () => {
  const { auth, reg } = enrol();
  const c = challenge();
  const a = softGet(auth, c, { origin: "https://claw-desk.tail1a2b3c.ts.net.evil.example", rpId: RP });
  assert.equal(code(() => verifyAssertion(a, assertExpect(reg, c))), "origin");
});

test("an assertion over a replayed challenge is refused", () => {
  const { auth, reg } = enrol();
  const old = challenge();
  const recorded = softGet(auth, old, { origin: ORIGIN, rpId: RP });
  const fresh = challenge();
  assert.equal(code(() => verifyAssertion(recorded, assertExpect(reg, fresh))), "challenge");
});

test("an assertion without the UV flag is refused", () => {
  const { auth, reg } = enrol();
  const c = challenge();
  const a = softGet(auth, c, { origin: ORIGIN, rpId: RP, uv: false });
  assert.equal(code(() => verifyAssertion(a, assertExpect(reg, c))), "uv");
});

test("an assertion signed by another key is refused", () => {
  const { reg } = enrol();
  const impostor = softAuthenticator();
  impostor.credentialId = Buffer.from(reg.credentialId, "base64url");
  const c = challenge();
  assert.equal(code(() => verifyAssertion(softGet(impostor, c, { origin: ORIGIN, rpId: RP }), assertExpect(reg, c))), "signature");
});

test("a create response is not accepted as an assertion, nor a get as a create", () => {
  const { auth, reg } = enrol();
  const c = challenge();
  const a = softGet(auth, c, { origin: ORIGIN, rpId: RP, type: "webauthn.create" });
  assert.equal(code(() => verifyAssertion(a, assertExpect(reg, c))), "type");
  const auth2 = softAuthenticator();
  const c2 = challenge();
  assert.equal(code(() => verifyRegistration(softCreate(auth2, c2, { origin: ORIGIN, rpId: RP, type: "webauthn.get" }), { ...EXPECT, challenge: c2 })), "type");
});

test("a signature counter that does not rise is refused; 0 after 0 is allowed", () => {
  const { auth, reg } = enrol();
  const c = challenge();
  const a = softGet(auth, c, { origin: ORIGIN, rpId: RP, counter: 5 });
  assert.equal(code(() => verifyAssertion(a, assertExpect(reg, c, 5))), "counter");
  const z = challenge();
  assert.equal(code(() => verifyAssertion(softGet(auth, z, { origin: ORIGIN, rpId: RP, counter: 0 }), assertExpect(reg, z, 0))), "accepted");
});

test("a cross-origin iframe's assertion is refused", () => {
  const { auth, reg } = enrol();
  const c = challenge();
  assert.equal(code(() => verifyAssertion(softGet(auth, c, { origin: ORIGIN, rpId: RP, crossOrigin: true }), assertExpect(reg, c))), "origin");
});

test("authenticatorData with trailing bytes or a short header is refused", () => {
  assert.throws(() => parseAuthData(Buffer.alloc(36)), WebAuthnError);
  assert.throws(() => parseAuthData(Buffer.alloc(40)), WebAuthnError);
});
