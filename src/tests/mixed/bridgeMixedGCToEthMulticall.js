// Test 3.3b: mixed xDAI->USDS + GNO->GNO on GC -> ETH in a single Multicall3 batch
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
  processGCMessages,
  getAllXdaiSignaturesFromReceipt,
  claimOnForeignBridge,
  overrideRelayedMessagesIfNeeded,
  getAMBMessagesFromReceipt,
  getAMBSignatures,
  claimAMBOnForeignRouter,
} from "../../utils/validator.js";
import {
  MULTICALL3_ADDRESS,
  call3Value,
  sendAggregate3Value,
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

const USDS_COUNT = 2; // xDAI -> USDS relays (native)
const GNO_COUNT = 2; // GNO -> GNO relays (ERC20)
const XDAI_AMOUNT = parseEther("10");
const GNO_AMOUNT = parseEther("1");
const XDAI_TOTAL = XDAI_AMOUNT * BigInt(USDS_COUNT);
const GNO_TOTAL = GNO_AMOUNT * BigInt(GNO_COUNT);
// Explicit gas — the native relayTokens path is hard to estimate and Multicall3
// forwards only 63/64 of gas per sub-call; budget ~2M per relay plus overhead.
const GAS_LIMIT = 2_000_000n * BigInt(USDS_COUNT + GNO_COUNT) + 1_000_000n;
// Accept --autoclaim from a direct `node` arg as well as npm's captured
// `npm run ... --autoclaim` form (exposed as npm_config_autoclaim).
const autoclaim =
  process.argv.includes("--autoclaim") ||
  process.env.npm_config_autoclaim === "true";

const relayRecipientAbi = [parseAbiItem("function relayTokens(address recipient)")];
const relayOmniAbi = [
  parseAbiItem("function relayTokens(address token, address _receiver, uint256 _value)"),
];

async function main() {
  console.log(
    `=== Test 3.3b: ${USDS_COUNT}x xDAI->USDS + ${GNO_COUNT}x GNO->ETH on GC -> ETH (Multicall3) ===\n`,
  );
  console.log(
    `  Mode: ${autoclaim ? "autoclaim (validator executes on foreign)" : "manual claim"}\n`,
  );

  // 1. Record initial balances
  const initialUsds = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.USDS, account.address);
  const initialGnoETH = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.GNO, account.address);
  const initialGnoGC = await getErc20Balance(gnoClient, BRIDGE_ADDRESSES.GC_GNO, account.address);
  console.log(`Initial USDS balance (ETH): ${initialUsds}`);
  console.log(`Initial GNO balance (ETH):  ${initialGnoETH}`);
  console.log(`Initial GNO balance (GC):   ${initialGnoGC}`);

  // 2. Approve Multicall3 to pull GNO from the user on GC (xDAI is native, no approval)
  console.log("\nApproving GNO to Multicall3 on GC...");
  const { request: approveReq } = await gnoClient.simulateContract({
    address: BRIDGE_ADDRESSES.GC_GNO,
    abi: erc20Abi,
    functionName: "approve",
    args: [MULTICALL3_ADDRESS, GNO_TOTAL],
  });
  const approveTx = await gnoClient.writeContract(approveReq);
  console.log(`Approve tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${approveTx}`);

  // 3. Build the mixed payable batch: native xDAI relays + ERC20 GNO relays
  const calls = [
    call3Value(BRIDGE_ADDRESSES.GC_GNO, 0n, erc20Abi, "transferFrom", [
      account.address,
      MULTICALL3_ADDRESS,
      GNO_TOTAL,
    ]),
    call3Value(BRIDGE_ADDRESSES.GC_GNO, 0n, erc20Abi, "approve", [
      BRIDGE_ADDRESSES.GC_OMNIBRIDGE,
      GNO_TOTAL,
    ]),
    ...Array.from({ length: USDS_COUNT }, () =>
      call3Value(
        BRIDGE_ADDRESSES.USDS_DEPOSIT_CONTRACT,
        XDAI_AMOUNT,
        relayRecipientAbi,
        "relayTokens",
        [account.address],
      ),
    ),
    ...Array.from({ length: GNO_COUNT }, () =>
      call3Value(BRIDGE_ADDRESSES.GC_OMNIBRIDGE, 0n, relayOmniAbi, "relayTokens", [
        BRIDGE_ADDRESSES.GC_GNO,
        account.address,
        GNO_AMOUNT,
      ]),
    ),
  ];

  console.log("\nRelaying mixed xDAI + GNO via Multicall3 batch...");
  const relayReceipt = await sendAggregate3Value(gnoClient, calls, XDAI_TOTAL, {
    gas: GAS_LIMIT,
  });
  console.log(
    `Batch tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${relayReceipt.transactionHash}`,
  );

  // 4. Verify the batch succeeded and emitted events
  assert(relayReceipt.status === "success", "Multicall batch succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in batch transaction");

  // 5. Verify GNO deducted on GC (xDAI deduction includes gas, checked implicitly)
  const midGnoGC = await getErc20Balance(gnoClient, BRIDGE_ADDRESSES.GC_GNO, account.address);
  assert(
    midGnoGC === initialGnoGC - GNO_TOTAL,
    `GNO deducted on GC by ${GNO_TOTAL}: ${initialGnoGC} -> ${midGnoGC}`,
  );

  if (!autoclaim) {
    // 6. Wait for validators, then claim both message types on Ethereum
    await processGCMessages();

    // 6a. xDAI bridge messages -> Foreign XDAI Bridge.executeSignatures
    const xdaiMessages = await getAllXdaiSignaturesFromReceipt(gnoClient, relayReceipt);
    assert(
      xdaiMessages.length === USDS_COUNT,
      `Collected ${xdaiMessages.length} xDAI messages (expected ${USDS_COUNT})`,
    );
    for (const [i, { message, signatures, nonce }] of xdaiMessages.entries()) {
      console.log(`\nClaiming USDS message ${i + 1}/${USDS_COUNT} on Ethereum...`);
      await overrideRelayedMessagesIfNeeded(ethClient, BRIDGE_ADDRESSES.XDAI_FOREIGN_BRIDGE, nonce);
      await claimOnForeignBridge(
        ethClient,
        BRIDGE_ADDRESSES.XDAI_FOREIGN_BRIDGE,
        message,
        signatures,
      );
    }

    // 6b. AMB/OmniBridge messages -> ForeignBridgeRouter.safeExecuteSignatures...
    const ambMessages = getAMBMessagesFromReceipt(relayReceipt);
    assert(
      ambMessages.length === GNO_COUNT,
      `Recovered ${ambMessages.length} AMB messages (expected ${GNO_COUNT})`,
    );
    for (const [i, message] of ambMessages.entries()) {
      console.log(`\nClaiming GNO message ${i + 1}/${GNO_COUNT} on Ethereum...`);
      const signatures = await getAMBSignatures(gnoClient, message);
      const claimReceipt = await claimAMBOnForeignRouter(
        ethClient,
        BRIDGE_ADDRESSES.BRIDGE_ROUTER,
        message,
        signatures,
      );
      assert(claimReceipt.status === "success", `GNO claim ${i + 1} succeeded`);
    }
  }

  // 7. Verify both tokens arrived on ETH
  console.log("\nWaiting for USDS and GNO balances to increase on ETH...");
  let finalUsds = initialUsds;
  let finalGnoETH = initialGnoETH;
  for (let attempt = 1; attempt <= 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 12000));
    finalUsds = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.USDS, account.address);
    finalGnoETH = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.GNO, account.address);
    console.log(`  Attempt ${attempt}/6: USDS = ${finalUsds}, GNO = ${finalGnoETH}`);
    if (finalUsds >= initialUsds + XDAI_TOTAL && finalGnoETH >= initialGnoETH + GNO_TOTAL) break;
  }
  assert(
    finalUsds >= initialUsds + XDAI_TOTAL,
    `USDS increased on ETH by ${XDAI_TOTAL}: ${initialUsds} -> ${finalUsds}`,
  );
  assert(
    finalGnoETH >= initialGnoETH + GNO_TOTAL,
    `GNO increased on ETH by ${GNO_TOTAL}: ${initialGnoETH} -> ${finalGnoETH}`,
  );

  console.log("\n=== Test 3.3b PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 3.3b FAILED ===", err);
  process.exitCode = 1;
});
