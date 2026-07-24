// FCR preflight, `safe` legitimately empty.
// Set the ETH (foreign, fcr under P2) mock so the `safe` tag returns
// `result: null`, restart the fcr watcher, and assert it treats this as None
// and falls back to `finalized` (does NOT fail loud). Restores safe→follow.
//
// Requires: a profile where ETH is fcr (P1/ff or P2/fb) + `npm run mock` + the
// amb oracle stack running.
//   node src/tests/finality/fcr/preflightSafeNull.js

import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { assertSafeNullFallsBack } from "../lib/preflightFlow.js";

async function main() {
  console.log("=== FCR preflight: safe null → finalized fallback ===\n");
  await assertSafeNullFallsBack({ source: "eth" });
  console.log("\n=== FCR preflight (null fallback) PASSED ===");
}

main().catch((err) => {
  console.error("\n=== FCR preflight (null fallback) FAILED ===", err);
  process.exitCode = 1;
});
