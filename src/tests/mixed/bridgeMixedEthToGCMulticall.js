// Test 3.3a: mixed USDS + GNO on ETH -> GC in a single Multicall3 batch
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
  waitForAddedReceiverEvents,
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

const USDS_COUNT = 2;
const GNO_COUNT = 2;
const BRIDGE_AMOUNT = parseEther("1");
const USDS_TOTAL = BRIDGE_AMOUNT * BigInt(USDS_COUNT);
const GNO_TOTAL = BRIDGE_AMOUNT * BigInt(GNO_COUNT);
// Explicit gas — Multicall3 forwards only 63/64 of gas per sub-call, so
// estimation comes up short for batched bridge relays.
const GAS_LIMIT = 2_000_000n * BigInt(USDS_COUNT + GNO_COUNT) + 1_000_000n;

// relayTokens(token, recipient, amount) — same selector on BridgeRouter & Omnibridge
const relayTokensAbi = [
  parseAbiItem("function relayTokens(address token, address recipient, uint256 amount)"),
];

async function approveMulticall3(token, amount) {
  const { request } = await ethClient.simulateContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [MULTICALL3_ADDRESS, amount],
  });
  const tx = await ethClient.writeContract(request);
  console.log(`Approve ${token}: ${virtual_mainnet.blockExplorers.default.url}/tx/${tx}`);
}

async function main() {
  console.log(
    `=== Test 3.3a: ${USDS_COUNT}x USDS + ${GNO_COUNT}x GNO on ETH -> GC (Multicall3) ===\n`,
  );

  // 1. Record initial balances and the GC block to scan events from
  const initialUsds = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.USDS, account.address);
  const initialGnoETH = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.GNO, account.address);
  const initialGnoGC = await getErc20Balance(gnoClient, BRIDGE_ADDRESSES.GC_GNO, account.address);
  const blockBeforeRelay = await gnoClient.getBlockNumber();
  console.log(`Initial USDS balance (ETH): ${initialUsds}`);
  console.log(`Initial GNO balance (ETH):  ${initialGnoETH}`);
  console.log(`Initial GNO balance (GC):   ${initialGnoGC}`);

  // 2. Approve Multicall3 to pull both tokens from the user
  console.log("\nApproving USDS and GNO to Multicall3...");
  await approveMulticall3(BRIDGE_ADDRESSES.USDS, USDS_TOTAL);
  await approveMulticall3(BRIDGE_ADDRESSES.GNO, GNO_TOTAL);

  // 3. Build the mixed batch: pull both tokens in, approve each bridge, relay
  const calls = [
    call3(BRIDGE_ADDRESSES.USDS, erc20Abi, "transferFrom", [account.address, MULTICALL3_ADDRESS, USDS_TOTAL]),
    call3(BRIDGE_ADDRESSES.GNO, erc20Abi, "transferFrom", [account.address, MULTICALL3_ADDRESS, GNO_TOTAL]),
    call3(BRIDGE_ADDRESSES.USDS, erc20Abi, "approve", [BRIDGE_ADDRESSES.BRIDGE_ROUTER, USDS_TOTAL]),
    call3(BRIDGE_ADDRESSES.GNO, erc20Abi, "approve", [BRIDGE_ADDRESSES.OMNIBRIDGE, GNO_TOTAL]),
    ...Array.from({ length: USDS_COUNT }, () =>
      call3(BRIDGE_ADDRESSES.BRIDGE_ROUTER, relayTokensAbi, "relayTokens", [
        BRIDGE_ADDRESSES.USDS,
        account.address,
        BRIDGE_AMOUNT,
      ]),
    ),
    ...Array.from({ length: GNO_COUNT }, () =>
      call3(BRIDGE_ADDRESSES.OMNIBRIDGE, relayTokensAbi, "relayTokens", [
        BRIDGE_ADDRESSES.GNO,
        account.address,
        BRIDGE_AMOUNT,
      ]),
    ),
  ];

  console.log("\nRelaying mixed USDS + GNO via Multicall3 batch...");
  const relayReceipt = await sendAggregate3(ethClient, calls, { gas: GAS_LIMIT });
  console.log(
    `Batch tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${relayReceipt.transactionHash}`,
  );

  // 4. Verify the batch succeeded and emitted events
  assert(relayReceipt.status === "success", "Multicall batch succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in batch transaction");

  // 5. Verify both tokens were deducted on ETH
  const finalUsds = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.USDS, account.address);
  const finalGnoETH = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.GNO, account.address);
  assert(finalUsds === initialUsds - USDS_TOTAL, `USDS deducted on ETH by ${USDS_TOTAL}: ${initialUsds} -> ${finalUsds}`);
  assert(finalGnoETH === initialGnoETH - GNO_TOTAL, `GNO deducted on ETH by ${GNO_TOTAL}: ${initialGnoETH} -> ${finalGnoETH}`);

  // 6. Confirm the USDS relays reached the Block Reward contract on GC
  console.log("\nWaiting for USDS relays (xDAI) on Gnosis Chain...");
  const logs = await waitForAddedReceiverEvents(
    gnoClient,
    BRIDGE_ADDRESSES.BLOCK_REWARD,
    account.address,
    BRIDGE_ADDRESSES.XDAI_HOME_BRIDGE,
    blockBeforeRelay,
    USDS_COUNT,
  );
  assert(logs.length >= USDS_COUNT, `Observed ${logs.length} AddedReceiver events (expected >= ${USDS_COUNT})`);

  // 7. Confirm the GNO relays arrived on GC
  console.log("\nWaiting for GNO to arrive on Gnosis Chain...");
  let finalGnoGC = initialGnoGC;
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    finalGnoGC = await getErc20Balance(gnoClient, BRIDGE_ADDRESSES.GC_GNO, account.address);
    console.log(`  GNO balance (GC) = ${finalGnoGC}`);
    if (finalGnoGC >= initialGnoGC + GNO_TOTAL) break;
  }
  assert(finalGnoGC >= initialGnoGC + GNO_TOTAL, `GNO increased on GC by ${GNO_TOTAL}: ${initialGnoGC} -> ${finalGnoGC}`);

  console.log("\n=== Test 3.3a PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 3.3a FAILED ===", err);
  process.exitCode = 1;
});
