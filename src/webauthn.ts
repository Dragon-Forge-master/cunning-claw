import crypto from "node:crypto";

/**
 * WebAuthn, server side, on node:crypto alone.
 *
 * Pocket Claw approves consequences from a phone, and the approval card is the
 * claw's real boundary. A device token alone would make a stolen, unlocked
 * phone a remote control; so every approve or deny from Pocket carries a fresh
 * assertion from the phone's platform authenticator — fingerprint, face or
 * screen lock — with user verification required, over a challenge that names
 * the approval it answers.
 *
 * Only what that needs is here: a strict CBOR reader (canonical, definite
 * lengths, bounded depth), authenticatorData and clientDataJSON parsing, COSE
 * keys for ES256 and RS256, and the registration and assertion checks of
 * WebAuthn Level 2 §7.1 and §7.2. Attestation is not trusted — Pocket asks for
 * "none" — because the credential is bound to this claw by the single-use
 * pairing code shown on the operator's own screen, not by who made the phone.
 */

export class WebAuthnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const fail = (code: string, message: string): never => {
  throw new WebAuthnError(code, message);
};

export const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");

export function fromB64url(s: unknown, what: string): Buffer {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) fail("encoding", `${what} is not base64url`);
  return Buffer.from(s as string, "base64url");
}

// --- CBOR (RFC 8949), the subset authenticators emit --------------------------

export type Cbor = number | bigint | string | boolean | null | undefined | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

/** Decode one item at `offset`; `end` says where it stopped, which authData needs. */
export function decodeCbor(buf: Uint8Array, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 16) fail("cbor", "CBOR nested too deeply");
  if (offset >= buf.length) fail("cbor", "CBOR ended early");
  const initial = buf[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let pos = offset + 1;
  const need = (n: number) => { if (pos + n > buf.length) fail("cbor", "CBOR ended early"); };
  let arg: number;
  if (info < 24) arg = info;
  else if (info === 24) { need(1); arg = buf[pos]; pos += 1; }
  else if (info === 25) { need(2); arg = (buf[pos] << 8) | buf[pos + 1]; pos += 2; }
  else if (info === 26) { need(4); arg = Buffer.from(buf.buffer, buf.byteOffset + pos, 4).readUInt32BE(0); pos += 4; }
  else if (info === 27) {
    need(8);
    const big = Buffer.from(buf.buffer, buf.byteOffset + pos, 8).readBigUInt64BE(0);
    pos += 8;
    if (major === 7) {
      return { value: Buffer.from(buf.buffer, buf.byteOffset + pos - 8, 8).readDoubleBE(0), end: pos };
    }
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail("cbor", "CBOR integer too large");
    arg = Number(big);
  } else {
    // 28-30 are reserved; 31 is indefinite length, which canonical CBOR forbids.
    return fail("cbor", "CBOR indefinite or reserved length");
  }
  switch (major) {
    case 0: return { value: arg, end: pos };
    case 1: return { value: -1 - arg, end: pos };
    case 2: need(arg); return { value: buf.slice(pos, pos + arg), end: pos + arg };
    case 3: need(arg); return { value: Buffer.from(buf.slice(pos, pos + arg)).toString("utf8"), end: pos + arg };
    case 4: {
      if (arg > buf.length) fail("cbor", "CBOR array longer than its buffer");
      const out: Cbor[] = [];
      for (let i = 0; i < arg; i++) {
        const item = decodeCbor(buf, pos, depth + 1);
        out.push(item.value);
        pos = item.end;
      }
      return { value: out, end: pos };
    }
    case 5: {
      if (arg > buf.length) fail("cbor", "CBOR map longer than its buffer");
      const out = new Map<Cbor, Cbor>();
      for (let i = 0; i < arg; i++) {
        const k = decodeCbor(buf, pos, depth + 1);
        const v = decodeCbor(buf, k.end, depth + 1);
        if (out.has(k.value)) fail("cbor", "CBOR map repeats a key");
        out.set(k.value, v.value);
        pos = v.end;
      }
      return { value: out, end: pos };
    }
    case 6: return decodeCbor(buf, pos, depth + 1); // a tag says nothing we act on
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22) return { value: null, end: pos };
      if (info === 23) return { value: undefined, end: pos };
      if (info === 25) return { value: halfToNumber(arg), end: pos };
      if (info === 26) return { value: Buffer.from(buf.buffer, buf.byteOffset + pos - 4, 4).readFloatBE(0), end: pos };
      return fail("cbor", "CBOR simple value not understood");
  }
  return fail("cbor", "CBOR major type not understood");
}

function halfToNumber(h: number): number {
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** Decode a whole buffer; trailing bytes mean it was not one CBOR item. */
export function decodeCborAll(buf: Uint8Array): Cbor {
  const { value, end } = decodeCbor(buf, 0);
  if (end !== buf.length) fail("cbor", "trailing bytes after CBOR");
  return value;
}

// --- authenticatorData ----------------------------------------------------------

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  attested?: { aaguid: Buffer; credentialId: Buffer; publicKey: Map<Cbor, Cbor> };
}

export function parseAuthData(buf: Uint8Array): AuthData {
  if (buf.length < 37) fail("authdata", "authenticatorData is shorter than 37 bytes");
  const b = Buffer.from(buf);
  const rpIdHash = b.subarray(0, 32);
  const flags = b[32];
  const signCount = b.readUInt32BE(33);
  let pos = 37;
  let attested: AuthData["attested"];
  if (flags & FLAG_AT) {
    if (b.length < pos + 18) fail("authdata", "attested credential data is truncated");
    const aaguid = b.subarray(pos, pos + 16);
    const idLen = b.readUInt16BE(pos + 16);
    pos += 18;
    if (idLen > 1023 || b.length < pos + idLen) fail("authdata", "credential id length is wrong");
    const credentialId = b.subarray(pos, pos + idLen);
    pos += idLen;
    const key = decodeCbor(b, pos);
    if (!(key.value instanceof Map)) fail("authdata", "credential public key is not a COSE map");
    pos = key.end;
    attested = { aaguid, credentialId, publicKey: key.value as Map<Cbor, Cbor> };
  }
  if (flags & FLAG_ED) {
    const ext = decodeCbor(b, pos);
    pos = ext.end;
  }
  if (pos !== b.length) fail("authdata", "authenticatorData has trailing bytes");
  return { rpIdHash, flags, signCount, attested };
}

// --- COSE keys --------------------------------------------------------------------

export const ES256 = -7;
export const RS256 = -257;

export interface StoredKey {
  alg: number;
  jwk: crypto.JsonWebKey;
}

export function coseToKey(cose: Map<Cbor, Cbor>): StoredKey {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label: number, what: string): Buffer => {
    const v = cose.get(label);
    if (!(v instanceof Uint8Array)) fail("cose", `COSE key has no ${what}`);
    return Buffer.from(v as Uint8Array);
  };
  if (kty === 2 && alg === ES256) {
    if (cose.get(-1) !== 1) fail("cose", "only the P-256 curve is accepted for ES256");
    const x = bytes(-2, "x");
    const y = bytes(-3, "y");
    if (x.length !== 32 || y.length !== 32) fail("cose", "P-256 coordinates must be 32 bytes");
    const jwk = { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) };
    // createPublicKey checks the point is on the curve (RFC 8291 §7 asks the same of push keys).
    try { crypto.createPublicKey({ key: jwk, format: "jwk" }); } catch { fail("cose", "the EC point is not on P-256"); }
    return { alg: ES256, jwk };
  }
  if (kty === 3 && alg === RS256) {
    const n = bytes(-1, "modulus");
    const e = bytes(-2, "exponent");
    if (n.length < 256) fail("cose", "RSA keys under 2048 bits are refused");
    const jwk = { kty: "RSA", n: b64url(n), e: b64url(e) };
    try { crypto.createPublicKey({ key: jwk, format: "jwk" }); } catch { fail("cose", "the RSA key does not parse"); }
    return { alg: RS256, jwk };
  }
  return fail("cose", `unsupported key (kty ${String(kty)}, alg ${String(alg)}); ES256 and RS256 are accepted`);
}

export function verifySignature(key: StoredKey, data: Buffer, sig: Buffer): boolean {
  try {
    const pub = crypto.createPublicKey({ key: key.jwk, format: "jwk" });
    if (key.alg === ES256) return crypto.verify("sha256", data, { key: pub, dsaEncoding: "der" }, sig);
    if (key.alg === RS256) return crypto.verify("sha256", data, pub, sig);
  } catch {
    return false; // a malformed DER signature is a failed signature, not a crash
  }
  return false;
}

// --- clientDataJSON -----------------------------------------------------------------

interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }

function checkClientData(raw: Buffer, type: string, expectedChallenge: string, origins: readonly string[]): void {
  let cd: ClientData;
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    return fail("clientdata", "clientDataJSON is not JSON");
  }
  if (cd.type !== type) fail("type", `clientData.type is ${String(cd.type)}, not ${type}`);
  // The challenge is the whole point: a string compare of the base64url the
  // browser echoed against the one this server minted and still holds.
  const want = Buffer.from(expectedChallenge);
  const got = Buffer.from(String(cd.challenge ?? ""));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) fail("challenge", "challenge does not match");
  if (!origins.includes(cd.origin)) fail("origin", `origin ${String(cd.origin)} is not this claw's Pocket address`);
  if (cd.crossOrigin === true) fail("origin", "a cross-origin iframe may not answer");
}

function checkRp(auth: AuthData, rpId: string): void {
  const want = crypto.createHash("sha256").update(rpId).digest();
  if (!auth.rpIdHash.equals(want)) fail("rpid", "rpIdHash is not for this claw's address");
  if (!(auth.flags & FLAG_UP)) fail("up", "user presence flag not set");
  // Required, never preferred: the card is a consequence, so the phone must
  // have checked the owner, not merely that somebody touched it.
  if (!(auth.flags & FLAG_UV)) fail("uv", "user verification flag not set — biometrics or screen lock required");
}

// --- Registration ----------------------------------------------------------------------

export interface RegistrationInput {
  id: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
}

export interface RegisteredCredential {
  credentialId: string;
  key: StoredKey;
  signCount: number;
  backupEligible: boolean;
}

export function verifyRegistration(
  cred: RegistrationInput,
  expect: { challenge: string; origins: readonly string[]; rpId: string },
): RegisteredCredential {
  if (cred?.type !== "public-key") fail("type", "credential type must be public-key");
  const clientData = fromB64url(cred.response?.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.create", expect.challenge, expect.origins);
  const att = decodeCborAll(fromB64url(cred.response?.attestationObject, "attestationObject"));
  if (!(att instanceof Map)) return fail("attestation", "attestationObject is not a map");
  const fmt = att.get("fmt");
  const authDataRaw = att.get("authData");
  const attStmt = att.get("attStmt");
  if (!(authDataRaw instanceof Uint8Array) || !(attStmt instanceof Map)) fail("attestation", "attestationObject is malformed");
  const authData = Buffer.from(authDataRaw as Uint8Array);
  const auth = parseAuthData(authData);
  checkRp(auth, expect.rpId);
  if (!auth.attested) return fail("authdata", "no attested credential data");
  const credentialId = b64url(auth.attested.credentialId);
  if (cred.id !== credentialId) fail("credential", "credential id does not match the authenticator's");
  const key = coseToKey(auth.attested.publicKey);
  const stmt = attStmt as Map<Cbor, Cbor>;
  if (fmt === "none") {
    if (stmt.size !== 0) fail("attestation", "a none attestation must have an empty statement");
  } else if (fmt === "packed") {
    // Some authenticators self-attest even when "none" was asked for. The
    // signature is checked so a forged object is still refused; the
    // certificate chain is not, because nothing here trusts a manufacturer.
    const alg = stmt.get("alg");
    const sig = stmt.get("sig");
    if (!(sig instanceof Uint8Array)) return fail("attestation", "packed attestation has no signature");
    const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
    const x5c = stmt.get("x5c");
    let signer: StoredKey;
    if (Array.isArray(x5c) && x5c[0] instanceof Uint8Array) {
      const cert = new crypto.X509Certificate(Buffer.from(x5c[0] as Uint8Array));
      signer = { alg: Number(alg), jwk: cert.publicKey.export({ format: "jwk" }) };
    } else {
      if (alg !== key.alg) fail("attestation", "self attestation alg does not match the credential");
      signer = key;
    }
    if (!verifySignature(signer, signed, Buffer.from(sig))) fail("signature", "attestation signature does not verify");
  } else {
    fail("attestation", `attestation format ${String(fmt)} is not accepted`);
  }
  return { credentialId, key, signCount: auth.signCount, backupEligible: Boolean(auth.flags & FLAG_BE) };
}

// --- Assertion -------------------------------------------------------------------------

export interface AssertionInput {
  id: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

/**
 * Verify one assertion. Returns the new signature counter for the caller to
 * store. A counter that fails to rise (when either side is non-zero) is a
 * cloned authenticator or a replayed response and is refused; many platform
 * authenticators always say 0, and 0 after 0 is accepted as the spec allows.
 */
export function verifyAssertion(
  a: AssertionInput,
  expect: { challenge: string; origins: readonly string[]; rpId: string; credentialId: string; key: StoredKey; signCount: number },
): { signCount: number } {
  if (a?.type !== "public-key") fail("type", "credential type must be public-key");
  if (a.id !== expect.credentialId) fail("credential", "not the credential this device enrolled");
  const clientData = fromB64url(a.response?.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.get", expect.challenge, expect.origins);
  const authData = fromB64url(a.response?.authenticatorData, "authenticatorData");
  const auth = parseAuthData(authData);
  checkRp(auth, expect.rpId);
  const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
  if (!verifySignature(expect.key, signed, fromB64url(a.response?.signature, "signature"))) {
    fail("signature", "assertion signature does not verify");
  }
  if ((auth.signCount !== 0 || expect.signCount !== 0) && auth.signCount <= expect.signCount) {
    fail("counter", "signature counter did not increase — a replay or a cloned authenticator");
  }
  return { signCount: auth.signCount };
}
