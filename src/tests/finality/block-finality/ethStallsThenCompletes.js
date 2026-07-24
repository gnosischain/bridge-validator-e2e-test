// bf (P3 direction) — block-finality on ETH: ETH→GC does NOT complete until the
// ETH deposit block is finalized, then completes. Source = ETH (block-finality
// under profile P3/bf). Deposit GNO ETH→GC; completion observed on-chain via the
// GC GNO balance increase. Combines bf-1 (stall) + bf-2 (complete) in one flow.
//
// Requires: a profile where ETH is block-finality (P3/bf or P4/bb) + `npm run mock`.
//   node src/tests/finality/block-finality/ethStallsThenCompletes.js

import { createWalletClient, http, publicActions, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import BRIDGE_ADDRESSES from "../../../utils/constant.js";
import {
  virtual_mainnet,
  virtual_gnosis,
  validateRpcUrls,
} from "../../../utils/viemClientAndNetwork.js";
import { getErc20Balance } from "../../../utils/validator.js";
import { deposit } from "../lib/deposit.js";
import { blockFinalityFlow } from "../lib/bfFlow.js";

validateRpcUrls();

const account = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const ethClient = createWalletClient({
  account,
  chain: virtual_mainnet,
  transport: http(),
}).extend(publicActions);
const gnoClient = createWalletClient({
  account,
  chain: virtual_gnosis,
  transport: http(),
}).extend(publicActions);

const BRIDGE_AMOUNT = parseEther("1");

async function main() {
  console.log("=== bf (P3): block-finality on ETH, stall then complete (ETH→GC) ===\n");

  const initialGnoGC = await getErc20Balance(
    gnoClient,
    BRIDGE_ADDRESSES.GC_GNO,
    account.address,
  );
  console.log(`Initial GNO balance (GC): ${initialGnoGC}`);

  await blockFinalityFlow({
    source: "eth",
    deposit: () =>
      deposit({
        client: ethClient,
        token: BRIDGE_ADDRESSES.GNO,
        bridge: BRIDGE_ADDRESSES.OMNIBRIDGE,
        receiver: account.address,
        amount: BRIDGE_AMOUNT,
        explorerUrl: virtual_mainnet.blockExplorers.default.url,
      }),
    // ETH→GC completion is on-chain: GC GNO balance rises once the validator
    // affirms (which only happens after the ETH block finalizes).
    makeIsComplete: () => async () => {
      const bal = await getErc20Balance(
        gnoClient,
        BRIDGE_ADDRESSES.GC_GNO,
        account.address,
      );
      return bal > initialGnoGC;
    },
  });

  console.log("\n=== bf (P3) PASSED (ETH block-finality: stalled, then completed) ===");
}

main().catch((err) => {
  console.error("\n=== bf (P3) FAILED ===", err);
  process.exitCode = 1;
});
