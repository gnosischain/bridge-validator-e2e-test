// Test 3.2b: 3x GNO on GC -> GNO on ETH in a single Multicall3 batch
import {
  createWalletClient,
  http,
  publicActions,
  parseAbiItem,
  parseEther,
  erc20Abi,
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
  waitForNextBlock,
  getAMBMessagesFromReceipt,
  getAMBSignatures,
  claimAMBOnForeignRouter,
} from "../../utils/validator.js";
import {
  MULTICALL3_ADDRESS,
  call3,
  sendAggregate3,
} from "../../utils/multicall.js";

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
const BRIDGE_AMOUNT = parseEther("1");
const TOTAL = BRIDGE_AMOUNT * BigInt(COUNT);
// Explicit gas — Multicall3 forwards only 63/64 of gas per sub-call, so
// estimation comes up short for batched bridge relays.
const GAS_LIMIT = 2_000_000n * BigInt(COUNT) + 500_000n;
const autoclaim = process.argv.includes("--autoclaim");

const relayTokensAbi = [
  parseAbiItem(
    "function relayTokens(address token, address _receiver, uint256 _value)",
  ),
];

async function main() {
  console.log(
    `=== Test 3.2b: ${COUNT}x GNO on GC -> GNO on ETH (Multicall3) ===\n`,
  );
  console.log(
    `  Mode: ${autoclaim ? "autoclaim (validator executes on foreign)" : "manual claim"}\n`,
  );

  // 1. Record initial balances
  const initialGnoGC = await getErc20Balance(
    gnoClient,
    BRIDGE_ADDRESSES.GC_GNO,
    account.address,
  );
  const initialGnoETH = await getErc20Balance(
    ethClient,
    BRIDGE_ADDRESSES.GNO,
    account.address,
  );
  console.log(`Initial GNO balance (GC):  ${initialGnoGC}`);
  console.log(`Initial GNO balance (ETH): ${initialGnoETH}`);

  // 2. Approve Multicall3 to pull the total GNO from the user on GC
  console.log("\nApproving GNO to Multicall3 on GC...");
  const { request: approveReq } = await gnoClient.simulateContract({
    address: BRIDGE_ADDRESSES.GC_GNO,
    abi: erc20Abi,
    functionName: "approve",
    args: [MULTICALL3_ADDRESS, TOTAL],
  });
  const approveTx = await gnoClient.writeContract(approveReq);
  console.log(
    `Approve tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${approveTx}`,
  );

  // 3. Build the batch: pull GNO in, approve GC Omnibridge, relay 3 times
  const calls = [
    call3(BRIDGE_ADDRESSES.GC_GNO, erc20Abi, "transferFrom", [
      account.address,
      MULTICALL3_ADDRESS,
      TOTAL,
    ]),
    call3(BRIDGE_ADDRESSES.GC_GNO, erc20Abi, "approve", [
      BRIDGE_ADDRESSES.GC_OMNIBRIDGE,
      TOTAL,
    ]),
    ...Array.from({ length: COUNT }, () =>
      call3(BRIDGE_ADDRESSES.GC_OMNIBRIDGE, relayTokensAbi, "relayTokens", [
        BRIDGE_ADDRESSES.GC_GNO,
        account.address,
        BRIDGE_AMOUNT,
      ]),
    ),
  ];

  console.log("\nRelaying 3x GNO via Multicall3 batch...");
  const relayReceipt = await sendAggregate3(gnoClient, calls, { gas: GAS_LIMIT });
  console.log(
    `Batch tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${relayReceipt.transactionHash}`,
  );

  // 4. Verify the batch succeeded and emitted events
  assert(relayReceipt.status === "success", "Multicall batch succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in batch transaction");

  // 5. Verify the full GNO amount was deducted on GC
  const midGnoGC = await getErc20Balance(
    gnoClient,
    BRIDGE_ADDRESSES.GC_GNO,
    account.address,
  );
  assert(
    midGnoGC === initialGnoGC - TOTAL,
    `GNO deducted on GC by ${TOTAL}: ${initialGnoGC} -> ${midGnoGC}`,
  );

  if (!autoclaim) {
    // 6. Recover each AMB message, wait for signatures, claim on Ethereum
    const messages = getAMBMessagesFromReceipt(relayReceipt);
    assert(
      messages.length === COUNT,
      `Recovered ${messages.length} AMB messages (expected ${COUNT})`,
    );

    await waitForNextBlock(gnoClient);

    for (const [i, message] of messages.entries()) {
      console.log(`\nClaiming GNO message ${i + 1}/${COUNT} on Ethereum...`);
      const signatures = await getAMBSignatures(gnoClient, message);
      const claimReceipt = await claimAMBOnForeignRouter(
        ethClient,
        BRIDGE_ADDRESSES.BRIDGE_ROUTER,
        message,
        signatures,
      );
      assert(claimReceipt.status === "success", `Claim ${i + 1} succeeded`);
    }
  }

  // 7. Verify the full GNO amount arrived on ETH
  console.log("\nWaiting for GNO balance to increase on ETH...");
  let finalGnoETH = initialGnoETH;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 12000));
    finalGnoETH = await getErc20Balance(
      ethClient,
      BRIDGE_ADDRESSES.GNO,
      account.address,
    );
    console.log(`  Attempt ${attempt}/5: GNO balance = ${finalGnoETH}`);
    if (finalGnoETH >= initialGnoETH + TOTAL) break;
  }
  assert(
    finalGnoETH >= initialGnoETH + TOTAL,
    `GNO increased on ETH by ${TOTAL}: ${initialGnoETH} -> ${finalGnoETH}`,
  );

  console.log("\n=== Test 3.2b PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 3.2b FAILED ===", err);
  process.exitCode = 1;
});
