// FCR preflight (GC source) — `safe` unsupported on the GC fcr watcher.
// Under `ethbf-gcfcr`, GC is fcr, so the GC signature-request watcher runs the `safe`
// probe. Set the GC mock's `safe` → -32602, restart that watcher, assert it
// alerts loudly and downgrades that chain to block-finality. Restores safe→follow.
//
// Requires: a profile where GC is fcr (`ethbf-gcfcr` or `ethfcr-gcfcr`) + `npm run mock` + amb stack.
//   node src/tests/finality/fcr/preflightSafeUnsupportedGc.js

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { assertSafeUnsupportedDowngrades } from "../lib/preflightFlow.js";

async function main() {
  console.log("=== FCR preflight (GC source): GC safe unsupported (downgrade to block-finality) ===\n");
  await assertSafeUnsupportedDowngrades({
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
