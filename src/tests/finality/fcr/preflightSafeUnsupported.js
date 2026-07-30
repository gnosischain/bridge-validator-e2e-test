// FCR Conditions 1–2 — startup preflight, `safe` unsupported.
// Set the ETH (foreign, fcr under `ethfcr-gcbf`) mock so the `safe` tag returns JSON-RPC
// -32602, restart the fcr watcher, and assert it ALERTS LOUDLY and then
// DOWNGRADES that chain to block-finality (never a silent fcr that is really
// running on finality). Restores safe→follow afterwards.
//
// Requires: a profile where ETH is fcr (`ethfcr-gcbf` or `ethfcr-gcfcr`) + `npm run mock` + a
// validator stack (oracle amb by default; FCR_COMPOSE/FCR_SERVICE/FCR_CONTAINER
// point it at the rust worker instead).
//   node src/tests/finality/fcr/preflightSafeUnsupported.js

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { assertSafeUnsupportedDowngrades } from "../lib/preflightFlow.js";

async function main() {
  console.log("=== FCR C1–2: preflight safe unsupported (downgrade to block-finality) ===\n");
  await assertSafeUnsupportedDowngrades({ source: "eth" });
  console.log("\n=== FCR preflight (unsupported) PASSED ===");
}

main().catch((err) => {
  console.error("\n=== FCR preflight (unsupported) FAILED ===", err);
  process.exitCode = 1;
});
