// Test 3.1a: 3x USDS on ETH -> xDAI on GC in a single Multicall3 batch
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

const COUNT = 3;
const BRIDGE_AMOUNT = parseEther("1");
const TOTAL = BRIDGE_AMOUNT * BigInt(COUNT);
// Explicit gas — Multicall3 forwards only 63/64 of gas per sub-call, so
// estimation comes up short for batched bridge relays.
const GAS_LIMIT = 2_000_000n * BigInt(COUNT) + 500_000n;

const relayTokensAbi = [
  parseAbiItem(
    "function relayTokens(address token, address recipient, uint256 amount)",
  ),
];

async function main() {
  console.log(
    `=== Test 3.1a: ${COUNT}x USDS on ETH -> xDAI on GC (Multicall3) ===\n`,
  );

  // 1. Record initial balances and the GC block to scan events from
  const initialUsds = await getErc20Balance(
    ethClient,
    BRIDGE_ADDRESSES.USDS,
    account.address,
  );
  const blockBeforeRelay = await gnoClient.getBlockNumber();
  console.log(`Initial USDS balance (ETH): ${initialUsds}`);

  // 2. Approve Multicall3 to pull the total USDS from the user (the batch runs
  //    as Multicall3, so it transferFroms the tokens into itself first).
  console.log("\nApproving USDS to Multicall3...");
  const { request: approveReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.USDS,
    abi: erc20Abi,
    functionName: "approve",
    args: [MULTICALL3_ADDRESS, TOTAL],
  });
  const approveTx = await ethClient.writeContract(approveReq);
  console.log(
    `Approve tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${approveTx}`,
  );

  // 3. Build the batch: pull USDS in, approve the router, then relay 3 times
  const calls = [
    call3(BRIDGE_ADDRESSES.USDS, erc20Abi, "transferFrom", [
      account.address,
      MULTICALL3_ADDRESS,
      TOTAL,
    ]),
    call3(BRIDGE_ADDRESSES.USDS, erc20Abi, "approve", [
      BRIDGE_ADDRESSES.BRIDGE_ROUTER,
      TOTAL,
    ]),
    ...Array.from({ length: COUNT }, () =>
      call3(BRIDGE_ADDRESSES.BRIDGE_ROUTER, relayTokensAbi, "relayTokens", [
        BRIDGE_ADDRESSES.USDS,
        account.address,
        BRIDGE_AMOUNT,
      ]),
    ),
  ];

  console.log("\nRelaying 3x USDS via Multicall3 batch...");
  const relayReceipt = await sendAggregate3(ethClient, calls, { gas: GAS_LIMIT });
  console.log(
    `Batch tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${relayReceipt.transactionHash}`,
  );

  // 4. Verify the batch succeeded and emitted events
  assert(relayReceipt.status === "success", "Multicall batch succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in batch transaction");

  // 5. Verify the full USDS amount was deducted on ETH
  const finalUsds = await getErc20Balance(
    ethClient,
    BRIDGE_ADDRESSES.USDS,
    account.address,
  );
  assert(
    finalUsds === initialUsds - TOTAL,
    `USDS deducted on ETH by ${TOTAL}: ${initialUsds} -> ${finalUsds}`,
  );

  // 6. Confirm all 3 relays reached the Block Reward contract on GC
  console.log("\nWaiting for bridge validator to relay to Gnosis Chain...");
  const logs = await waitForAddedReceiverEvents(
    gnoClient,
    BRIDGE_ADDRESSES.BLOCK_REWARD,
    account.address,
    BRIDGE_ADDRESSES.XDAI_HOME_BRIDGE,
    blockBeforeRelay,
    COUNT,
  );
  assert(
    logs.length >= COUNT,
    `Observed ${logs.length} AddedReceiver events (expected >= ${COUNT})`,
  );

  console.log("\n=== Test 3.1a PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 3.1a FAILED ===", err);
  process.exitCode = 1;
});
