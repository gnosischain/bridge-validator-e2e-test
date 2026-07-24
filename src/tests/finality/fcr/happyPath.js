// FCR Condition 3 — happy path: pending → confirmed.
// Source = ETH (fcr under profile P2/fb). Deposit GNO ETH→GC; the fcr watcher
// records the deposit block as pending (processed at `safe`), and once finality
// crosses it the fcrTxsChecker validates the (unchanged) hash and prunes it →
// confirmed, with no false positive.
//
// Requires: a profile where ETH is fcr (P1/ff or P2/fb) + `npm run mock`.
//   node src/tests/finality/fcr/happyPath.js

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
import { fcrHappyPathFlow } from "../lib/fcrFlow.js";
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
  console.log("=== FCR C3: happy path pending → confirmed (ETH→GC) ===\n");

  await fcrHappyPathFlow({
    source: "eth", // ETH = oracle foreign = fcr under P2
    redisUrl: REDIS_URLS.amb, // omnibridge stack Redis (:6379)
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

  console.log("\n=== FCR C3 PASSED (pending → confirmed) ===");
}

main().catch((err) => {
  console.error("\n=== FCR C3 FAILED ===", err);
  process.exitCode = 1;
});
