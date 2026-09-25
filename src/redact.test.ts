import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { redact, containsSecret, redactDeep } from "./redact.js";

/**
 * Every one of these shapes reaches history.json and the SSE stream in normal
 * use — pasted by the user, or returned by a tool reading a config file or an
 * HTTP response.
 *
 * The fixtures below are synthetic. They match the real formats so the patterns
 * are genuinely exercised, but no working credential belongs in a repository,
 * least of all in the tests for the thing that redacts credentials.
 */

const SAMPLES: [string, string][] = [
  ["anthropic", "sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa"],
  ["github", "ghp_EXAMPLEfake000011112222333344445555"],
  ["google-oauth", "AQ.Ab8EXAMPLEfake0000111122223333444455556666"],
  ["google-api", "AIzaSyA1234567890abcdefghijklmnopqrstuvw"], // gitleaks:allow (synthetic fixture)
  ["aws", "AKIAIOSFODNN7EXAMPLE"],
  ["slack", "xoxb-123456789012-abcdefghijklmnop"],
  ["stripe", "sk_live_51H8xKfGhIjKlMnOpQrStUvWx"], // gitleaks:allow (synthetic fixture)
  ["openrouter", "sk-or-v1-0123456789abcdef0123456789abcdef"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh"], // gitleaks:allow (synthetic fixture)
];

for (const [label, secret] of SAMPLES) {
  test(`redacts ${label}`, () => {
    const out = redact(`here is my key: ${secret} — use it`);
    assert.ok(!out.includes(secret), `${label} survived redaction`);
    assert.match(out, /REDACTED/);
    assert.ok(out.includes("here is my key"), "surrounding text is preserved");
  });
}

test("redacts an unfamiliar provider via the generic assignment rule", () => {
  const out = redact("SOME_VENDOR_API_KEY=zzzz1111yyyy2222xxxx3333");
  assert.ok(!out.includes("zzzz1111yyyy2222xxxx3333"));
  assert.match(out, /SOME_VENDOR_API_KEY=\[REDACTED\]/);
});

test("redacts Authorization headers and JSON credential fields", () => {
  assert.match(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"), /Bearer \[REDACTED\]/);
  assert.match(redact('{"api_key": "abcdefghijklmnopqrst"}'), /"api_key": "\[REDACTED\]"/);
});

test("redacts private key blocks whole", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(redact(pem), "[private-key:REDACTED]");
});

test("leaves innocent text alone", () => {
  for (const clean of [
    "Good evening, sir. All systems nominal.",
    "run: git status && npm test",
    "the disk is 28% full and uptime is 8.6h",
  ]) {
    assert.equal(redact(clean), clean, clean);
    assert.equal(containsSecret(clean), false);
  }
});

test("is idempotent — redacting twice changes nothing further", () => {
  const once = redact(`key ${SAMPLES[0][1]}`);
  assert.equal(redact(once), once);
});

test("redactDeep reaches strings inside message content blocks", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: `token ${SAMPLES[1][1]}` },
      { type: "tool_result", content: [{ type: "text", text: `and ${SAMPLES[2][1]}` }] },
    ],
  };
  const out = JSON.stringify(redactDeep(msg));
  assert.ok(!out.includes(SAMPLES[1][1]), "nested text redacted");
  assert.ok(!out.includes(SAMPLES[2][1]), "doubly-nested tool_result redacted");
  assert.match(out, /"role":"user"/, "structure preserved");
});

test("containsSecret flags a pasted credential", () => {
  assert.equal(containsSecret(`my key is ${SAMPLES[0][1]}`), true);
});

test("local endpoints are recognised so offline models need no key", async () => {
  const { isLocalEndpoint } = await import("./brain.js");
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1",
                       "http://192.168.1.50:11434/v1", "http://box.local:1234/v1"]) {
    assert.equal(isLocalEndpoint(local), true, local);
  }
  for (const remote of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1"]) {
    assert.equal(isLocalEndpoint(remote), false, remote);
  }
});

test("redaction never touches image data, and never emits non-ASCII", async () => {
  const { redactDeep, isCleanBase64 } = await import("./redact.js");

  // A long base64 run will eventually look like a token. Replacing part of it
  // produces an image the API rejects, poisoning every later turn.
  // Valid base64, but containing a run the generic APIKEY= rule matches — which
  // is exactly how a real screenshot gets mangled.
  const payload = "iVBORw0KGgoAAAANSUhEUgAA" + "QUJD".repeat(30) +
    "APIKEY=AAAABBBBCCCCDDDDEEEE" + "Zm9v".repeat(30);
  const msg = {
    role: "user",
    content: [{
      type: "tool_result",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: payload } }],
    }],
  };
  const out: any = redactDeep(msg);
  const data = out.content[0].content[0].source.data;
  assert.equal(data, payload, "image payload must be returned untouched");
  assert.ok(isCleanBase64(data), "and must remain valid base64");
});

test("every redaction marker is ASCII", async () => {
  const { redact } = await import("./redact.js");
  const out = redact("key sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa");
  // A non-ASCII character inside a base64 payload invalidates the whole request.
  assert.ok(/^[\x00-\x7F]*$/.test(out), `marker must be ASCII-only, got: ${out}`);
  assert.match(out, /REDACTED/);
});

test("replicate and huggingface tokens are redacted (synthetic)", () => {
  // Synthetic tokens, never real: a live r8_ token once sailed through this
  // list into a config file, the history, and a day's journal.
  const r8 = redact("REPLICATE_API_TOKEN=r8_SyntheticTestTokenAbc123Def456Ghi789");
  assert.doesNotMatch(r8, /r8_Synthetic/);
  assert.match(r8, /REDACTED/);
  const hf = redact("token: hf_SyntheticTestTokenAbc123Def456Ghi789");
  assert.doesNotMatch(hf, /hf_Synthetic/);
  assert.match(hf, /REDACTED/);
});

// --- Passwords said in words ------------------------------------------------ //
// A field review of the operator's journal found a sudo password typed into
// the chat, because the assistant had asked for it, sitting in plain text in
// the journal and the model history. Every value below is synthetic.

test("a password said in words is redacted, and the words are kept", () => {
  for (const [said, kept] of [
    ["my password is hunter2x", "my password is [REDACTED]"],
    ["My Password Is Hunter2x!", "My Password Is [REDACTED]"],
    ["sudo password: abc123", "sudo password: [REDACTED]"],
    ["the passwd is foo", "the passwd is [REDACTED]"],
    ["pw = bar99", "pw = [REDACTED]"],
    ["sudo password hunter2x", "sudo password [REDACTED]"],
    ["ok, root password hunter2x.", "ok, root password [REDACTED]"],
    ["the password for root is abc123", "the password for root is [REDACTED]"],
    ['my password is "correct horse battery"', 'my password is "[REDACTED]"'],
    ["db_password: s3cret", "db_password: [REDACTED]"],
    ["mysql --password=abc123 -u root", "mysql --password=[REDACTED] -u root"],
    ['{"password": "hunter2x"}', '{"password": "[REDACTED]"}'],
  ]) {
    assert.equal(redact(said), kept, said);
    assert.equal(containsSecret(said), true, said);
  }
});

test("ordinary talk about passwords is left alone, even beside a disclosure", () => {
  // Each prose line rides with a real disclosure, so one assertion proves both
  // halves: the prose untouched to the character, the secret gone.
  const disclosure = "; my password is hunter2x";
  for (const prose of [
    "I keep it in a password manager",
    "please reset my password",
    "click the password field",
    "I forgot the password",
    "a strong password is important",
    "the password is incorrect",
    "your password is too short",
    "sudo: a password is required",
    "[sudo] password for owner: Sorry, try again.",
    "grep: /etc/passwd: Permission denied",
    "passwd: password updated successfully",
    "Password:",
  ]) {
    assert.equal(redact(prose + disclosure), prose + "; my password is [REDACTED]", prose);
  }
});

test("a password label does not reach across a newline", () => {
  assert.equal(redact("Password:\nnext line\npw: abc123"), "Password:\nnext line\npw: [REDACTED]");
});

test("env references and masks are not secrets, so an mcp.json entry naming one passes", () => {
  // tools.ts refuses any mcp.json snippet containsSecret() flags; "${VAR}" is
  // the pattern it tells the model to use instead, so it must never trip.
  assert.equal(containsSecret('"password": "hunter2x"'), true);
  for (const ref of ['"password": "${DB_PASS}"', "DB_PASSWORD=$DB_PASS", "password: ****", "pw: <your-password>"]) {
    assert.equal(containsSecret(ref), false, ref);
  }
});

test("password redaction is idempotent", () => {
  const once = redact("sudo password: abc123 and my password is hunter2x");
  assert.equal(once, "sudo password: [REDACTED] and my password is [REDACTED]");
  assert.equal(redact(once), once);
});

// --- The home directory ----------------------------------------------------- //
// The same review found full home paths, username and all, in the assistant's
// replies and tool results on the HUD, the voice, the phones and the journal.
// "/home/owner" stands in for the operator's home; no real username belongs here.

const HOME = "/home/owner";

test("the home directory collapses to ~ wherever it starts a path", () => {
  assert.equal(redact("saved to /home/owner/notes.txt, done", HOME), "saved to ~/notes.txt, done");
  assert.equal(redact("cd /home/owner", HOME), "cd ~");
  assert.equal(redact('"/home/owner/Game Dev/x" (/home/owner).', HOME), '"~/Game Dev/x" (~).');
  assert.equal(redact("PATH=/usr/bin:/home/owner/bin", HOME), "PATH=/usr/bin:~/bin");
  assert.equal(redact("open file:///home/owner/a.html", HOME), "open file://~/a.html");
});

test("other users, lookalikes and paths that merely contain the home are left alone", () => {
  const text = "/home/owner/a /home/ownerx/b /home/owner.bak/c /home/owner-old/d /home/other/e /mnt/b/home/owner/f";
  assert.equal(redact(text, HOME),
    "~/a /home/ownerx/b /home/owner.bak/c /home/owner-old/d /home/other/e /mnt/b/home/owner/f");
  // A service account whose home is "/" must not turn every path into "~".
  assert.equal(redact("/etc/hosts /home/owner/x", "/"), "/etc/hosts /home/owner/x");
  assert.equal(redact("/home/owner/x", HOME + "/"), "~/x", "a trailing slash on the home is ignored");
});

test("a Windows home collapses with either separator and any drive-letter case", () => {
  const win = "C:\\Users\\Name";
  assert.equal(redact("C:\\Users\\Name\\Documents\\a.txt", win), "~\\Documents\\a.txt");
  assert.equal(redact("see c:/users/name/x", win), "see ~/x");
  assert.equal(redact('{"p":"C:\\\\Users\\\\Name\\\\y"}', win), '{"p":"~\\\\y"}');
  assert.equal(redact("C:\\Users\\Namex\\z D:\\Users\\Name\\z", win), "C:\\Users\\Namex\\z D:\\Users\\Name\\z");
});

test("by default the collapse uses this machine's own home", (t) => {
  const home = os.homedir();
  if (!home || home === path.parse(home).root) return t.skip("no real home on this box");
  assert.equal(redact(`read ${path.join(home, "notes.txt")}`), `read ~${path.sep}notes.txt`);
});

test("a home path is collapsed but never reported as a secret", () => {
  // containsSecret gates the mcp.json write; an entry whose args name a file
  // under ~ is correct and must not be refused.
  const entry = '"args": ["/home/owner/tools/server.js"]';
  assert.equal(redact(entry, HOME), '"args": ["~/tools/server.js"]');
  assert.equal(containsSecret(entry), false);
});

test("redactDeep collapses the home inside nested blocks and arrays", () => {
  const msg = { content: [{ type: "text", text: "at /home/owner/a" }, ["/home/owner/b", "/home/owner/c"]] };
  assert.deepEqual(redactDeep(msg, HOME), { content: [{ type: "text", text: "at ~/a" }, ["~/b", "~/c"]] });
});

test("the home collapse is idempotent", () => {
  const once = redact("/home/owner/a and ~/b", HOME);
  assert.equal(once, "~/a and ~/b");
  assert.equal(redact(once, HOME), once);
});

test("a bare password typed straight after the claw asked for one is recognised", async () => {
  const { isSecretReply } = await import("./redact.js");
  const asked = "I need your sudo password to install that, sir.";
  assert.equal(isSecretReply(asked, "Tr0ub4dor&3"), true);
  assert.equal(isSecretReply(asked, "correcthorse"), true, "letters alone still count when it was asked for");
  assert.equal(isSecretReply("Enter the PIN from the card.", "4417"), true);
  // Ordinary answers to the same question are left alone.
  assert.equal(isSecretReply(asked, "no"), false);
  assert.equal(isSecretReply(asked, "cancel"), false);
  assert.equal(isSecretReply(asked, "carry on"), false);
  assert.equal(isSecretReply(asked, "I'll run it myself"), false, "a sentence is not a password");
  // And a one-word reply to anything else is just a word.
  assert.equal(isSecretReply("Which folder, sir?", "Documents"), false);
  assert.equal(isSecretReply("", "Tr0ub4dor&3"), false);
});
