// FCR preflight (P3 direction) — `safe` unsupported on the GC fcr watcher.
// Under P3/bf, GC is fcr, so the GC signature-request watcher runs the `safe`
// probe. Set the GC mock's `safe` → -32602, restart that watcher, assert it
// fails loud. Restores safe→follow.
//
// Requires: a profile where GC is fcr (P3/bf or P1/ff) + `npm run mock` + amb stack.
//   node src/tests/finality/fcr/preflightSafeUnsupportedGc.js

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { assertSafeUnsupportedFailsLoud } from "../lib/preflightFlow.js";

async function main() {
  console.log("=== FCR preflight (P3): GC safe unsupported (fail loud) ===\n");
  await assertSafeUnsupportedFailsLoud({
    source: "gc",
    service: "bridge_request_amb",
    container: "docker-bridge_request_amb-1",
  });
  console.log("\n=== FCR preflight GC (unsupported) PASSED ===");
}

main().catch((err) => {
  console.error("\n=== FCR preflight GC (unsupported) FAILED ===", err);
  process.exitCode = 1;
});
