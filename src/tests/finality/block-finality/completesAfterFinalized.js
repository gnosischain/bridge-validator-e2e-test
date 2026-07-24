// bf-2: a block-finality validator attests once the source block is finalized.
// Source = GC (block-finality under profile P2/fb). Deposit GNO GC→ETH, pin GC
// `finalized` below the deposit block, assert a brief stall, then advance GC
// finality past the block (evm_increaseBlocks) and assert the validator signs.
//
// Requires: a profile where GC is block-finality (P2/fb or P4/bb) + `npm run mock`.
//   node src/tests/finality/block-finality/completesAfterFinalized.js

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
import { deposit, extractAMBMessage, isMessageSigned } from "../lib/deposit.js";
import { blockFinalityFlow } from "../lib/bfFlow.js";

validateRpcUrls();

const account = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const gnoClient = createWalletClient({
  account,
  chain: virtual_gnosis,
  transport: http(),
}).extend(publicActions);

const BRIDGE_AMOUNT = parseEther("1");

async function main() {
  console.log("=== bf-2: block-finality completes after finalized (GC→ETH) ===\n");

  await blockFinalityFlow({
    source: "gc",
    // Shorter stall window here — bf-1 owns the exhaustive negative assertion;
    // bf-2 just confirms the gate lifts once finality advances.
    negativeWindowMs: 20000,
    deposit: () =>
      deposit({
        client: gnoClient,
        token: BRIDGE_ADDRESSES.GC_GNO,
        bridge: BRIDGE_ADDRESSES.GC_OMNIBRIDGE,
        receiver: account.address,
        amount: BRIDGE_AMOUNT,
        explorerUrl: virtual_gnosis.blockExplorers.default.url,
      }),
    makeIsComplete: ({ receipt }) => {
      const { message } = extractAMBMessage(receipt);
      return () => isMessageSigned(gnoClient, message);
    },
  });

  console.log("\n=== bf-2 PASSED (validator attested after finalization) ===");
}

main().catch((err) => {
  console.error("\n=== bf-2 FAILED ===", err);
  process.exitCode = 1;
});
