// bf-1: a block-finality validator does NOT attest while the source block is
// unfinalized. Source = GC (block-finality under profile P2/fb). We deposit
// GNO GC→ETH, pin GC `finalized` below the deposit block, and assert the
// validator does not sign within a bounded window.
//
// Requires: a profile where GC is block-finality (P2/fb or P4/bb) + `npm run mock`.
//   node src/tests/finality/block-finality/stallsUntilFinalized.js

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
  console.log("=== bf-1: block-finality stalls until finalized (GC→ETH) ===\n");

  await blockFinalityFlow({
    source: "gc",
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
    stopAfterStall: true,
  });

  console.log("\n=== bf-1 PASSED (validator did not attest while unfinalized) ===");
}

main().catch((err) => {
  console.error("\n=== bf-1 FAILED ===", err);
  process.exitCode = 1;
});
