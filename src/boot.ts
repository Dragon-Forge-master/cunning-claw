/**
 * Process entry. Notes whether a brain can run, then loads the server.
 * `server.ts` still owns HTTP — this file only decides whether to start it.
 *
 * `--import <folder>` (passed through by every launcher) brings an old
 * download's keys and memory in instead, and exits (src/import-old.ts).
 * Dynamic imports, so that path never loads the server.
 */
const importAt = process.argv.indexOf("--import");
if (importAt >= 0) {
  const { importCli } = await import("./import-old.js");
  process.exit(await importCli(process.argv[importAt + 1]));
}

// No key no longer means no start: the server comes up and the setup page
// asks for one (src/first-run.ts).
const { prepareBoot } = await import("./first-run.js");
await prepareBoot();
await import("./server.js");
