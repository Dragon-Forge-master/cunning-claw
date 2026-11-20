import net from "node:net";
import { config, HOME_ROOT, ROOT } from "./config.js";
import { importOldInstall } from "./home-root.js";
import { collapseHome } from "./paths.js";

/**
 * `<launcher> --import <old folder>`: bring an old unzipped download's keys,
 * config, memory and workspace into this claw (src/home-root.ts does the
 * copying). Run from a launcher, so it works the same for an installed app,
 * an AppImage and a fresh unzip.
 *
 * It refuses while a claw is answering on this one's port: a running claw
 * rewrites history.json and memory as it goes, and would write over the
 * import, or the import over it.
 */
function portAnswers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (yes: boolean) => { socket.destroy(); resolve(yes); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

export async function importCli(from: string | undefined): Promise<number> {
  if (!from) {
    console.error("Say which folder: --import <the old Cunning Claw folder you unzipped>");
    return 2;
  }
  if (await portAnswers(config.server.port, config.server.host || "127.0.0.1")) {
    console.error(`Cunning Claw is running (port ${config.server.port}). Close his window first, then import again.`);
    return 1;
  }
  try {
    const r = importOldInstall({ from, codeRoot: ROOT, homeRoot: HOME_ROOT });
    console.log(`Imported from ${collapseHome(r.from)} into ${collapseHome(HOME_ROOT)}:`);
    console.log(`  ${r.copied.length} file(s)${r.keys.length ? `, and these keys from .env: ${r.keys.join(", ")}` : ""}`);
    if (r.backup) console.log(`  Anything it replaced is kept in ${collapseHome(r.backup)}`);
    console.log("Start Cunning Claw as usual. Delete the old folder whenever you are happy.");
    return 0;
  } catch (err) {
    console.error(`Nothing was imported: ${(err as Error).message}`);
    return 1;
  }
}
