// Test 3.1b: 3x xDAI on GC -> USDS on ETH in a single Multicall3 batch
import {
  createWalletClient,
  http,
  publicActions,
  parseAbiItem,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import BRIDGE_ADDRESSES from "../../utils/constant.js";
import {
  virtual_mainnet,
  virtual_gnosis,
  validateRpcUrls,
} from "../../utils/viemClientAndNetwork.js";
import {
  assert,
  getErc20Balance,
  processGCMessages,
  getAllXdaiSignaturesFromReceipt,
  claimOnForeignBridge,
  overrideRelayedMessagesIfNeeded,
} from "../../utils/validator.js";
import { call3Value, sendAggregate3Value } from "../../utils/multicall.js";

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

const COUNT = 3;
const BRIDGE_AMOUNT = parseEther("10");
const TOTAL = BRIDGE_AMOUNT * BigInt(COUNT);
// Explicit gas — the native relayTokens path is hard to estimate (the single
// test hardcodes 2M for one relay); budget that per relay plus batch overhead.
const GAS_LIMIT = 2_000_000n * BigInt(COUNT) + 500_000n;
const autoclaim = process.argv.includes("--autoclaim");

const relayTokensAbi = [parseAbiItem("function relayTokens(address recipient)")];

async function main() {
  console.log(
    `=== Test 3.1b: ${COUNT}x xDAI on GC -> USDS on ETH (Multicall3) ===\n`,
  );
  console.log(
    `  Mode: ${autoclaim ? "autoclaim (validator executes on foreign)" : "manual claim"}\n`,
  );

  // 1. Record initial balances
  const initialXdai = await gnoClient.getBalance({ address: account.address });
  const initialUsds = await getErc20Balance(
    ethClient,
    BRIDGE_ADDRESSES.USDS,
    account.address,
  );
  console.log(`Initial xDAI balance (GC):  ${initialXdai}`);
  console.log(`Initial USDS balance (ETH): ${initialUsds}`);

  // 2. Build a payable batch: 3 native xDAI relays through the USDS Deposit Contract
  const calls = Array.from({ length: COUNT }, () =>
    call3Value(
      BRIDGE_ADDRESSES.USDS_DEPOSIT_CONTRACT,
      BRIDGE_AMOUNT,
      relayTokensAbi,
      "relayTokens",
      [account.address],
    ),
  );

  console.log("\nRelaying 3x xDAI via Multicall3 batch...");
  const relayReceipt = await sendAggregate3Value(gnoClient, calls, TOTAL, {
    gas: GAS_LIMIT,
  });
  console.log(
    `Batch tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${relayReceipt.transactionHash}`,
  );

  // 3. Verify the batch succeeded and emitted events
  assert(relayReceipt.status === "success", "Multicall batch succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in batch transaction");

  // 4. Verify xDAI deducted on GC (value + gas)
  const midXdai = await gnoClient.getBalance({ address: account.address });
  assert(
    midXdai < initialXdai - TOTAL,
    `xDAI balance deducted on GC: ${initialXdai} -> ${midXdai}`,
  );

  if (!autoclaim) {
    // 5. Wait for validator signatures, then claim each message on Ethereum
    await processGCMessages();
    const messages = await getAllXdaiSignaturesFromReceipt(
      gnoClient,
      relayReceipt,
    );
    assert(
      messages.length === COUNT,
      `Collected ${messages.length} signed messages (expected ${COUNT})`,
    );

    for (const [i, { message, signatures, nonce }] of messages.entries()) {
      console.log(`\nClaiming USDS message ${i + 1}/${COUNT} on Ethereum...`);
      await overrideRelayedMessagesIfNeeded(
        ethClient,
        BRIDGE_ADDRESSES.XDAI_FOREIGN_BRIDGE,
        nonce,
      );
      await claimOnForeignBridge(
        ethClient,
        BRIDGE_ADDRESSES.XDAI_FOREIGN_BRIDGE,
        message,
        signatures,
      );
    }
  }

  // 6. Verify the full USDS amount arrived on ETH
  console.log("\nWaiting for USDS balance to increase on ETH...");
  let finalUsds = initialUsds;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 12000));
    finalUsds = await getErc20Balance(
      ethClient,
      BRIDGE_ADDRESSES.USDS,
      account.address,
    );
    console.log(`  Attempt ${attempt}/5: USDS balance = ${finalUsds}`);
    if (finalUsds >= initialUsds + TOTAL) break;
  }
  assert(
    finalUsds >= initialUsds + TOTAL,
    `USDS increased on ETH by ${TOTAL}: ${initialUsds} -> ${finalUsds}`,
  );

  console.log("\n=== Test 3.1b PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 3.1b FAILED ===", err);
  process.exitCode = 1;
});
