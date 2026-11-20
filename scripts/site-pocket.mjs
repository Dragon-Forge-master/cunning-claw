// Copies the phone app from public/pocket/ into site/pocket/, so
// cunningclaw.com serves the very files a claw serves on the tailnet.
//
//   npm run site:pocket      (then `wrangler pages deploy` from site/ as usual)
//
// One file differs, by one line: the site's index.html says it is the site
// (<meta name="pocket-home" content="site">), which tells pocket.js that the
// relay is its only way home. One file is added: release.json, naming the
// claw version the copy was made from and the SHA-256 of every file served,
// so anyone can check what cunningclaw.com serves against a tagged release
// (docs/POCKET-RELAY.md, "A compromised website"). Everything else is byte
// for byte the same,
// and src/site-pocket.test.ts fails if site/pocket/ drifts from this output —
// so a change to the phone app cannot reach the website unreviewed, and the
// website cannot carry a phone app the repository does not.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = path.join(ROOT, "public", "pocket");
export const TARGET = path.join(ROOT, "site", "pocket");
export const SITE_MARK = '  <meta name="pocket-home" content="site">\n';

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

/** The site's copy of the app, as path → bytes. */
export function buildSitePocket(source = SOURCE) {
  const files = new Map();
  for (const rel of walk(source)) {
    let bytes = fs.readFileSync(path.join(source, rel));
    if (rel === "index.html") {
      const html = bytes.toString("utf8");
      const at = html.indexOf("  <title>");
      if (at < 0) throw new Error("public/pocket/index.html has no <title> line to put the site mark before");
      bytes = Buffer.from(html.slice(0, at) + SITE_MARK + html.slice(at));
    }
    files.set(rel, bytes);
  }
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const hashes = Object.fromEntries([...files].map(([rel, bytes]) => [rel, crypto.createHash("sha256").update(bytes).digest("hex")]));
  files.set("release.json", Buffer.from(`${JSON.stringify({ app: "pocket", version, sha256: hashes }, null, 2)}\n`));
  return files;
}

/** Every file under site/pocket/, as path → bytes. */
export function readSitePocket(target = TARGET) {
  const files = new Map();
  if (!fs.existsSync(target)) return files;
  for (const rel of walk(target)) files.set(rel, fs.readFileSync(path.join(target, rel)));
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const want = buildSitePocket();
  fs.rmSync(TARGET, { recursive: true, force: true });
  for (const [rel, bytes] of want) {
    const p = path.join(TARGET, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
  console.log(`site/pocket/: ${want.size} files from public/pocket/`);
}
