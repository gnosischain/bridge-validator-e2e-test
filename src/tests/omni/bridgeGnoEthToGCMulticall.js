// Test 3.2a: 3x GNO on ETH -> GNO on GC in a single Multicall3 batch
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
import { assert, getErc20Balance } from "../../utils/validator.js";
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

const relayTokensAbi = [
  parseAbiItem(
    "function relayTokens(address token, address _receiver, uint256 _value)",
  ),
];

async function main() {
  console.log(
    `=== Test 3.2a: ${COUNT}x GNO on ETH -> GNO on GC (Multicall3) ===\n`,
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

  // 2. Approve Multicall3 to pull the total GNO from the user
  console.log("\nApproving GNO to Multicall3...");
  const { request: approveReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.GNO,
    abi: erc20Abi,
    functionName: "approve",
    args: [MULTICALL3_ADDRESS, TOTAL],
  });
  const approveTx = await ethClient.writeContract(approveReq);
  console.log(
    `Approve tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${approveTx}`,
  );

  // 3. Build the batch: pull GNO in, approve Omnibridge, relay 3 times
  const calls = [
    call3(BRIDGE_ADDRESSES.GNO, erc20Abi, "transferFrom", [
      account.address,
      MULTICALL3_ADDRESS,
      TOTAL,
    ]),
    call3(BRIDGE_ADDRESSES.GNO, erc20Abi, "approve", [
      BRIDGE_ADDRESSES.OMNIBRIDGE,
      TOTAL,
    ]),
    ...Array.from({ length: COUNT }, () =>
      call3(BRIDGE_ADDRESSES.OMNIBRIDGE, relayTokensAbi, "relayTokens", [
        BRIDGE_ADDRESSES.GNO,
        account.address,
        BRIDGE_AMOUNT,
      ]),
    ),
  ];

  console.log("\nRelaying 3x GNO via Multicall3 batch...");
  const relayReceipt = await sendAggregate3(ethClient, calls, { gas: GAS_LIMIT });
  console.log(
    `Batch tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${relayReceipt.transactionHash}`,
  );

  // 4. Verify the batch succeeded and emitted events
  assert(relayReceipt.status === "success", "Multicall batch succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in batch transaction");

  // 5. Verify the full GNO amount was deducted on ETH
  const finalGnoETH = await getErc20Balance(
    ethClient,
    BRIDGE_ADDRESSES.GNO,
    account.address,
  );
  assert(
    finalGnoETH === initialGnoETH - TOTAL,
    `GNO deducted on ETH by ${TOTAL}: ${initialGnoETH} -> ${finalGnoETH}`,
  );

  // 6. Wait for the full GNO amount to arrive on GC
  console.log("\nWaiting for bridge validator to relay to Gnosis Chain...");
  let finalGnoGC = initialGnoGC;
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    finalGnoGC = await getErc20Balance(
      gnoClient,
      BRIDGE_ADDRESSES.GC_GNO,
      account.address,
    );
    console.log(`  GNO balance (GC) = ${finalGnoGC}`);
    if (finalGnoGC >= initialGnoGC + TOTAL) break;
  }
  assert(
    finalGnoGC >= initialGnoGC + TOTAL,
    `GNO increased on GC by ${TOTAL}: ${initialGnoGC} -> ${finalGnoGC}`,
  );

  console.log("\n=== Test 3.2a PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 3.2a FAILED ===", err);
  process.exitCode = 1;
});
