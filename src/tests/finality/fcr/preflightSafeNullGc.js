// FCR preflight (GC source) — `safe` null on the GC fcr watcher.
// Under `ethbf-gcfcr`, GC is fcr, so the GC signature-request watcher runs the `safe`
// probe. Set the GC mock's `safe` → null, restart that watcher, assert it treats
// it as legit-empty and falls back to `finalized`. Restores safe→follow.
//
// Requires: a profile where GC is fcr (`ethbf-gcfcr` or `ethfcr-gcfcr`) + `npm run mock` + amb stack.
//   node src/tests/finality/fcr/preflightSafeNullGc.js

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { assertSafeNullFallsBack } from "../lib/preflightFlow.js";

async function main() {
  console.log("=== FCR preflight (GC source): GC safe null → finalized fallback ===\n");
  await assertSafeNullFallsBack({
    source: "gc",
    service: "bridge_request_amb",
    container: "docker-bridge_request_amb-1",
  });
  console.log("\n=== FCR preflight GC (null fallback) PASSED ===");
}

main().catch((err) => {
  console.error("\n=== FCR preflight GC (null fallback) FAILED ===", err);
  process.exitCode = 1;
});
