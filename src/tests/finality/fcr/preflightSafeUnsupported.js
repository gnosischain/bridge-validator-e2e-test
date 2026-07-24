// FCR Conditions 1–2 — startup preflight, `safe` unsupported.
// Set the ETH (foreign, fcr under P2) mock so the `safe` tag returns JSON-RPC
// -32602, restart the fcr watcher, and assert it FAILS LOUD (retries the probe,
// no silent downgrade). Restores safe→follow afterwards.
//
// Requires: a profile where ETH is fcr (P1/ff or P2/fb) + `npm run mock` + the
// amb oracle stack running.
//   node src/tests/finality/fcr/preflightSafeUnsupported.js

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { assertSafeUnsupportedFailsLoud } from "../lib/preflightFlow.js";

async function main() {
  console.log("=== FCR C1–2: preflight safe unsupported (fail loud) ===\n");
  await assertSafeUnsupportedFailsLoud({ source: "eth" });
  console.log("\n=== FCR preflight (unsupported) PASSED ===");
}

main().catch((err) => {
  console.error("\n=== FCR preflight (unsupported) FAILED ===", err);
  process.exitCode = 1;
});
