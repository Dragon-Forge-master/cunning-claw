#!/usr/bin/env node
/**
 * The one-command door to Cunning Claw:  npx cunningclaw
 *
 * This is an installer, not the claw itself. It checks the ground, fetches the
 * repository, runs the real install, and tells you how to light the forge.
 * Nothing here phones home, collects anything, or runs without saying so —
 * the doctrine applies to the installer too.
 */

const { execSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "https://github.com/Dragon-Forge-master/cunning-claw.git";
const DIR = "cunning-claw";

const cyan = (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

console.log("");
console.log(cyan("  CUNNING CLAW") + dim("  ·  y dyn hysbys  ·  installer"));
console.log(dim("  Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau"));
console.log(dim("  (local first · human consent where there are consequences)"));
console.log("");

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`  Node 22+ is required (you have ${process.versions.node}). https://nodejs.org`);
  process.exit(1);
}

try {
  execSync("git --version", { stdio: "ignore" });
} catch {
  console.error("  git is required. https://git-scm.com — then run npx cunningclaw again.");
  process.exit(1);
}

const target = path.resolve(process.cwd(), DIR);
if (fs.existsSync(target)) {
  console.log(`  ${DIR}/ already exists here. To update it:`);
  console.log(cyan(`    cd ${DIR} && npm run update`));
  process.exit(0);
}

console.log(`  Fetching the claw into ./${DIR} …`);
const clone = spawnSync("git", ["clone", "--depth", "1", REPO, DIR], { stdio: "inherit" });
if (clone.status !== 0) {
  console.error("");
  console.error("  The clone failed. If the repository is still private, the public release");
  console.error("  has not opened yet — watch " + cyan("github.com/Dragon-Forge-master/cunning-claw"));
  process.exit(clone.status ?? 1);
}

console.log("");
console.log("  Installing dependencies …");
const install = spawnSync("npm", ["install"], { cwd: target, stdio: "inherit", shell: process.platform === "win32" });
if (install.status !== 0) {
  console.error("  npm install failed — the messages above name the problem.");
  process.exit(install.status ?? 1);
}

console.log("");
console.log(cyan("  The forge is built. To light it:"));
console.log(`    cd ${DIR}`);
console.log("    cp .env.example .env   " + dim("# add your OPENROUTER_API_KEY, or configure a local model"));
console.log("    npm run doctor         " + dim("# names anything missing, one line each"));
console.log("    npm run dev            " + dim("# then open http://127.0.0.1:3900"));
console.log("");
console.log(dim("  At your service."));
console.log("");
