// FCR C3 (GC source) — happy path on GC: pending → confirmed.
// Source = GC (fcr under profile `ethbf-gcfcr`). Deposit GNO GC→ETH; the GC fcr watcher
// (signature-request, home) records the deposit block pending at `safe`, and
// once finality crosses it the checker validates the hash → confirmed.
//
// Requires: a profile where GC is fcr (`ethbf-gcfcr` or `ethfcr-gcfcr`) + `npm run mock`.
//   node src/tests/finality/fcr/happyPathGcSource.js

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
import { fcrHappyPathFlow } from "../lib/fcrFlow.js";
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
  console.log("=== FCR C3 (GC source): happy path pending → confirmed (GC→ETH) ===\n");

  await fcrHappyPathFlow({
    source: "gc", // GC = oracle home = fcr under `ethbf-gcfcr`
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

  console.log("\n=== FCR C3 (GC source) PASSED (pending → confirmed) ===");
}

main().catch((err) => {
  console.error("\n=== FCR C3 (GC source) FAILED ===", err);
  process.exitCode = 1;
});
