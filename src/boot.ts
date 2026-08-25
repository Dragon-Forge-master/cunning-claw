/**
 * Process entry. Checks a brain can actually run, then loads the server.
 * `server.ts` still owns HTTP — this file only decides whether to start it.
 */
import { assertReadyToBoot } from "./first-run.js";

await assertReadyToBoot();
await import("./server.js");
