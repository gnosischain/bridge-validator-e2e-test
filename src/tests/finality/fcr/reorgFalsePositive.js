// FCR Condition 4 — reorg → false positive.
// Source = ETH (fcr under profile P2/fb). Deposit GNO ETH→GC; once the fcr
// watcher has stored the deposit block as pending (real hash captured at
// `safe`), arm a reorg for that block so it returns a different hash. When
// finality crosses it the fcrTxsChecker revalidates, detects the hash mismatch,
// and records a false positive (detector-only — nothing is undone on-chain).
//
// Requires: a profile where ETH is fcr (P1/ff or P2/fb) + `npm run mock`.
//   node src/tests/finality/fcr/reorgFalsePositive.js

import { createWalletClient, http, publicActions, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import BRIDGE_ADDRESSES from "../../../utils/constant.js";
import {
  virtual_mainnet,
  validateRpcUrls,
} from "../../../utils/viemClientAndNetwork.js";
import { deposit } from "../lib/deposit.js";
import { fcrReorgFalsePositiveFlow } from "../lib/fcrFlow.js";
import { REDIS_URLS } from "../../../observer/index.js";

validateRpcUrls();

const account = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const ethClient = createWalletClient({
  account,
  chain: virtual_mainnet,
  transport: http(),
}).extend(publicActions);

const BRIDGE_AMOUNT = parseEther("1");

async function main() {
  console.log("=== FCR C4: reorg → false positive (ETH→GC) ===\n");

  await fcrReorgFalsePositiveFlow({
    source: "eth",
    redisUrl: REDIS_URLS.amb,
    deposit: () =>
      deposit({
        client: ethClient,
        token: BRIDGE_ADDRESSES.GNO,
        bridge: BRIDGE_ADDRESSES.OMNIBRIDGE,
        receiver: account.address,
        amount: BRIDGE_AMOUNT,
        explorerUrl: virtual_mainnet.blockExplorers.default.url,
      }),
  });

  console.log("\n=== FCR C4 PASSED (reorged block → false positive recorded) ===");
}

main().catch((err) => {
  console.error("\n=== FCR C4 FAILED ===", err);
  process.exitCode = 1;
});
