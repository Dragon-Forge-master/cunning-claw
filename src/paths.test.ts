import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSensitivePath, chromeProfileDir, expandHome, collapseHome } from "./paths.js";
import { ROOT, DATA_DIR } from "./config.js";

// Explicit absolute paths rather than ~/ throughout: a container running as
// root has homedir /root, which the legacy floor rule blocks wholesale, so ~/
// cases would pass here for the wrong reason and prove nothing.

test("the denylist covers the credentials this product creates itself", () => {
  // These were all readable before: .env holds CLAW_TOKEN and every provider
  // key, mcp-oauth.json holds live OAuth access and refresh tokens, and the
  // Chrome profile holds the cookies that ARE the logged-in Gmail session.
  assert.equal(isSensitivePath(path.join(ROOT, ".env")), true);
  assert.equal(isSensitivePath(path.join(DATA_DIR, "mcp-oauth.json")), true);
  assert.equal(isSensitivePath(path.join(DATA_DIR, "history.json")), true);
  assert.equal(isSensitivePath(path.join(chromeProfileDir(), "Default", "Cookies")), true);
});

test("the denylist covers the standard secret stores", () => {
  for (const p of [
    "/home/owner/.aws/credentials",
    "/home/owner/.config/gcloud/application_default_credentials.json",
    "/home/owner/.gnupg/secring.gpg",
    "/home/owner/.kube/config",
    "/home/owner/.docker/config.json",
    "/home/owner/.git-credentials",
    "/home/owner/.npmrc",
    "/home/owner/.netrc",
    "/home/owner/certs/server.pem",
    "/home/owner/project/.env",
    "/home/owner/project/.env.local",
  ]) {
    assert.equal(isSensitivePath(p), true, `${p} should be blocked`);
  }
});

test("the denylist is not inert on Windows paths", () => {
  // The old rule was written with forward slashes only, so on the platform the
  // README sells as "nothing to install" it matched nothing at all.
  assert.equal(isSensitivePath("C:\\Users\\owner\\.ssh\\id_rsa"), true);
  assert.equal(isSensitivePath("C:\\repo\\.env"), true);
  assert.equal(isSensitivePath("C:\\Users\\owner\\.aws\\credentials"), true);
});

test("the original floor still holds", () => {
  assert.equal(isSensitivePath("/etc/shadow"), true);
  assert.equal(isSensitivePath("/etc/sudoers"), true);
  assert.equal(isSensitivePath("/home/owner/.ssh/id_rsa"), true);
  assert.equal(isSensitivePath("/home/owner/.ssh/authorized_keys"), true);
});

test("ordinary files and env templates stay readable", () => {
  // Over-blocking is its own failure: .env.example is copied by install.sh and
  // deliberately listed by the coding tools, and data/todos.json is the claw's
  // own bookkeeping. Blocking those would just confuse it about its own state.
  for (const p of [
    "/home/owner/notes.txt",
    "/home/owner/src/index.ts",
    "/home/owner/project/.env.example",
    "/home/owner/project/.env.sample",
    path.join(ROOT, ".env.example"),
    path.join(ROOT, "workspace", "MEMORY.md"),
    path.join(DATA_DIR, "todos.json"),
  ]) {
    assert.equal(isSensitivePath(p), false, `${p} should stay readable`);
  }
});

test("a symlink cannot be used to walk around the denylist", () => {
  // workspace/ is a free-write zone, so without resolving the link
  // `ln -s ~/.ssh/id_rsa workspace/notes.txt` reads a private key through a
  // name that matches no rule.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-paths-"));
  try {
    const secretDir = path.join(dir, ".ssh");
    fs.mkdirSync(secretDir);
    const secret = path.join(secretDir, "id_rsa");
    fs.writeFileSync(secret, "PRIVATE KEY");
    const innocent = path.join(dir, "notes.txt");
    fs.symlinkSync(secret, innocent);

    assert.equal(isSensitivePath(secret), true, "the real path is blocked");
    assert.equal(isSensitivePath(innocent), true, "and so is the link to it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isSensitivePath never throws, whatever it is handed", () => {
  for (const p of ["", "   ", "~", "relative/path.txt", "/does/not/exist/at/all"]) {
    assert.doesNotThrow(() => isSensitivePath(p));
  }
  assert.equal(expandHome("~"), os.homedir());
});

test("collapseHome hides the username and touches nothing else", () => {
  // The home is passed explicitly for the same reason as the comment at the
  // top of this file: the real one here is /root, which proves nothing.
  const home = path.join(path.sep, "home", "chris");
  assert.equal(collapseHome(path.join(home, "Projects", "claw"), home), path.join("~", "Projects", "claw"));
  assert.equal(collapseHome(home, home), "~");
  // A sibling that merely shares the prefix is a different user's directory.
  assert.equal(collapseHome(path.join(path.sep, "home", "chris2", "x"), home), path.join(path.sep, "home", "chris2", "x"));
  assert.equal(collapseHome(path.join(path.sep, "opt", "claw"), home), path.join(path.sep, "opt", "claw"));
});
