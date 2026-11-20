import crypto from "node:crypto";

/**
 * A software WebAuthn authenticator on node:crypto keys, for the tests.
 *
 * The server never imports this. It exists so the checks in src/webauthn.ts
 * and the Pocket routes can be driven end to end without a phone: it makes
 * the same bytes a platform authenticator does (CBOR attestation object,
 * authenticatorData, a DER or PKCS#1 signature over authData ‖ SHA-256 of
 * clientDataJSON), and each knob a test needs to turn — the origin the
 * browser reports, the UV flag, the counter — is a parameter, because each is
 * an attack the verifier must refuse.
 */

type CborIn = number | string | boolean | Uint8Array | CborIn[] | Map<CborIn, CborIn>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function encodeCbor(v: CborIn): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "boolean") return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(encodeCbor(k), encodeCbor(val));
  return Buffer.concat(parts);
}

export interface SoftAuthenticator {
  credentialId: Buffer;
  alg: -7 | -257;
  counter: number;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export function softAuthenticator(alg: -7 | -257 = -7): SoftAuthenticator {
  const pair = alg === -7
    ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
    : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { credentialId: crypto.randomBytes(32), alg, counter: 0, ...pair };
}

function coseKey(a: SoftAuthenticator): Buffer {
  const jwk = a.publicKey.export({ format: "jwk" });
  const m = new Map<CborIn, CborIn>();
  if (a.alg === -7) {
    m.set(1, 2); m.set(3, -7); m.set(-1, 1);
    m.set(-2, Buffer.from(jwk.x!, "base64url"));
    m.set(-3, Buffer.from(jwk.y!, "base64url"));
  } else {
    m.set(1, 3); m.set(3, -257);
    m.set(-1, Buffer.from(jwk.n!, "base64url"));
    m.set(-2, Buffer.from(jwk.e!, "base64url"));
  }
  return encodeCbor(m);
}

export interface Knobs {
  origin: string;
  rpId: string;
  /** User verification: false is a phone that took a tap but checked nobody. */
  uv?: boolean;
  up?: boolean;
  /** Force a counter value instead of incrementing (replay and clone tests). */
  counter?: number;
  type?: string;
  crossOrigin?: boolean;
}

function authData(a: SoftAuthenticator, k: Knobs, attested: boolean): Buffer {
  const flags = (k.up === false ? 0 : 0x01) | (k.uv === false ? 0 : 0x04) | (attested ? 0x40 : 0);
  const count = Buffer.alloc(4);
  const n = k.counter ?? (attested ? a.counter : ++a.counter);
  count.writeUInt32BE(n >>> 0);
  const parts: Buffer[] = [crypto.createHash("sha256").update(k.rpId).digest(), Buffer.from([flags]), count];
  if (attested) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(a.credentialId.length);
    parts.push(Buffer.alloc(16), len, a.credentialId, coseKey(a));
  }
  return Buffer.concat(parts);
}

function clientData(type: string, challenge: string, k: Knobs): Buffer {
  return Buffer.from(JSON.stringify({ type: k.type ?? type, challenge, origin: k.origin, crossOrigin: k.crossOrigin ?? false }));
}

function sign(a: SoftAuthenticator, data: Buffer): Buffer {
  return a.alg === -7
    ? crypto.sign("sha256", data, { key: a.privateKey, dsaEncoding: "der" })
    : crypto.sign("sha256", data, a.privateKey);
}

/** navigator.credentials.create(), as the JSON Pocket's page posts. */
export function softCreate(a: SoftAuthenticator, challenge: string, k: Knobs, fmt: "none" | "packed" = "none") {
  const ad = authData(a, k, true);
  const cd = clientData("webauthn.create", challenge, k);
  const att = new Map<CborIn, CborIn>([["fmt", fmt], ["attStmt", new Map()], ["authData", ad]]);
  if (fmt === "packed") {
    const sig = sign(a, Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]));
    att.set("attStmt", new Map<CborIn, CborIn>([["alg", a.alg], ["sig", sig]]));
  }
  return {
    id: a.credentialId.toString("base64url"),
    type: "public-key",
    response: { clientDataJSON: cd.toString("base64url"), attestationObject: encodeCbor(att).toString("base64url") },
  };
}

/** navigator.credentials.get(), as the JSON Pocket's page posts. */
export function softGet(a: SoftAuthenticator, challenge: string, k: Knobs) {
  const ad = authData(a, k, false);
  const cd = clientData("webauthn.get", challenge, k);
  const sig = sign(a, Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]));
  return {
    id: a.credentialId.toString("base64url"),
    type: "public-key",
    response: {
      clientDataJSON: cd.toString("base64url"),
      authenticatorData: ad.toString("base64url"),
      signature: sig.toString("base64url"),
      userHandle: null,
    },
  };
}
