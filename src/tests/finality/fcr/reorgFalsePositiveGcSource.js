// FCR C4 (GC source) — reorg → false positive on GC.
// Source = GC (fcr under profile `ethbf-gcfcr`). Deposit GNO GC→ETH; once the GC fcr
// watcher has stored the block pending (real hash at `safe`), arm a reorg for
// that block. When finality crosses it the checker detects the hash mismatch and
// records a false positive on the `home` chain.
//
// Requires: a profile where GC is fcr (`ethbf-gcfcr` or `ethfcr-gcfcr`) + `npm run mock`.
//   node src/tests/finality/fcr/reorgFalsePositiveGcSource.js

import { createWalletClient, http, publicActions, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import BRIDGE_ADDRESSES from "../../../utils/constant.js";
import {
  virtual_gnosis,
  validateRpcUrls,
} from "../../../utils/viemClientAndNetwork.js";
import { deposit } from "../lib/deposit.js";
import { fcrReorgFalsePositiveFlow } from "../lib/fcrFlow.js";
import { REDIS_URLS } from "../../../observer/index.js";

validateRpcUrls();

const account = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const gnoClient = createWalletClient({
  account,
  chain: virtual_gnosis,
  transport: http(),
}).extend(publicActions);

const BRIDGE_AMOUNT = parseEther("1");

async function main() {
  console.log("=== FCR C4 (GC source): reorg → false positive (GC→ETH) ===\n");

  await fcrReorgFalsePositiveFlow({
    source: "gc",
    redisUrl: REDIS_URLS.amb,
    deposit: () =>
      deposit({
        client: gnoClient,
        token: BRIDGE_ADDRESSES.GC_GNO,
        bridge: BRIDGE_ADDRESSES.GC_OMNIBRIDGE,
        receiver: account.address,
        amount: BRIDGE_AMOUNT,
        explorerUrl: virtual_gnosis.blockExplorers.default.url,
      }),
  });

  console.log("\n=== FCR C4 (GC source) PASSED (reorged block → false positive) ===");
}

main().catch((err) => {
  console.error("\n=== FCR C4 (GC source) FAILED ===", err);
  process.exitCode = 1;
});
