import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  sendPush,
  vapidAuthorization,
  validSubscription,
} from "./webpush.js";

/**
 * A push that is encrypted wrongly is silently dropped by the push service, so
 * the only proof that approvals reach the lock screen is the RFC's own vector.
 */

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg", // gitleaks:allow (RFC 8291 published test vector)
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const RFC_SUB = { endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

test("encryption reproduces the RFC 8291 §5 message byte for byte", () => {
  const body = encryptPayload(Buffer.from(RFC.plaintext), RFC_SUB, {
    senderPrivate: Buffer.from(RFC.asPrivate, "base64url"),
    salt: Buffer.from(RFC.salt, "base64url"),
  });
  assert.equal(body.toString("base64url"), RFC.body);
  // 86-byte header + 41 plaintext + delimiter + 16-byte tag. The example's
  // "Content-Length: 145" is one more than its own body decodes to.
  assert.equal(body.length, 144);
});

test("the RFC 8291 message decrypts with the receiver's key", () => {
  const out = decryptPayload(Buffer.from(RFC.body, "base64url"), Buffer.from(RFC.uaPrivate, "base64url"), Buffer.from(RFC.auth, "base64url"));
  assert.equal(out.toString(), RFC.plaintext);
});

test("a fresh message uses a fresh key and salt every time", () => {
  const a = encryptPayload(Buffer.from("x"), RFC_SUB);
  const b = encryptPayload(Buffer.from("x"), RFC_SUB);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salt must not repeat");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "sender key must not repeat");
});

test("the VAPID JWT is ES256 over aud/exp/sub and verifies with the advertised key (RFC 8292)", () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://example.org/claw", 1_700_000_000);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], keys.publicKey);
  const [h, p, s] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);
  assert.ok(claims.exp - 1_700_000_000 <= 24 * 3600, "RFC 8292 caps exp at 24h");
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const sig = Buffer.from(s, "base64url");
  assert.equal(sig.length, 64, "JWS ES256 is raw r||s, not DER");
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, sig));
});

test("only real push services are accepted as endpoints — a paired phone cannot aim the claw at the LAN", () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
  assert.ok(validSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/xyz", keys }));
  assert.ok(validSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys }));
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/xyz",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.1/",
    "https://localhost:3900/api/chat",
    "https://fcm.googleapis.com.evil.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
  ]) {
    assert.equal(validSubscription({ endpoint, keys }), null, endpoint);
  }
});

test("a subscription key that is not on P-256 is refused", () => {
  const bad = Buffer.alloc(65, 1);
  bad[0] = 4;
  assert.equal(validSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: bad.toString("base64url"), auth: RFC.auth } }), null);
  assert.equal(validSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: RFC.uaPublic, auth: "c2hvcnQ" } }), null);
});

test("sendPush posts an aes128gcm body the phone can open, and reports a gone subscription", async () => {
  const keys = generateVapidKeys();
  const seen: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(null, { status: seen.length === 1 ? 201 : 410 });
  }) as unknown as typeof fetch;
  const msg = { title: "Pocket Claw", body: "2 approvals waiting", tag: "approvals", url: "/pocket/#approvals", count: 2 };
  assert.deepEqual(await sendPush(RFC_SUB, msg, keys, "https://example.org", fake), { ok: true });
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.match(h.Authorization, /^vapid t=/);
  const opened = decryptPayload(Buffer.from(seen[0].init.body as Buffer), Buffer.from(RFC.uaPrivate, "base64url"), Buffer.from(RFC.auth, "base64url"));
  assert.deepEqual(JSON.parse(opened.toString()), msg);
  const second = await sendPush(RFC_SUB, msg, keys, "https://example.org", fake);
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.gone, true);
});
