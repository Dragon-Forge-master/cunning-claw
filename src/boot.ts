/**
 * Process entry. Notes whether a brain can run, then loads the server.
 * `server.ts` still owns HTTP — this file only decides whether to start it.
 */
import { prepareBoot } from "./first-run.js";

// No key no longer means no start: the server comes up and the setup page
// asks for one (src/first-run.ts).
await prepareBoot();
await import("./server.js");
