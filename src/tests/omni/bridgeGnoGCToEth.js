// Test 2.4: GNO on GC -> GNO on ETH via Omnibridge
import {
  createWalletClient,
  http,
  publicActions,
  parseAbiItem,
  parseEther,
  parseEventLogs,
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
import { assert, getErc20Balance, waitForNextBlock } from "../../utils/validator.js";

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
// Accept --autoclaim from a direct `node` arg as well as npm's captured
// `npm run ... --autoclaim` form (exposed as npm_config_autoclaim).
const autoclaim =
  process.argv.includes("--autoclaim") ||
  process.env.npm_config_autoclaim === "true";

async function main() {
  console.log("=== Test 2.4: GNO on GC -> GNO on ETH ===\n");
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

  // 2. Approve GNO to Omnibridge on GC
  console.log("\nApproving GNO to GC Omnibridge...");
  const { request: approveReq } = await gnoClient.simulateContract({
    address: BRIDGE_ADDRESSES.GC_GNO,
    abi: [parseAbiItem("function approve(address spender, uint256 amount)")],
    functionName: "approve",
    args: [BRIDGE_ADDRESSES.GC_OMNIBRIDGE, BRIDGE_AMOUNT],
  });
  const approveTx = await gnoClient.writeContract(approveReq);
  console.log(
    `Approve tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${approveTx}`,
  );

  // 3. Relay GNO via GC Omnibridge
  console.log("\nRelaying GNO via GC Omnibridge...");
  const { request: relayReq } = await gnoClient.simulateContract({
    address: BRIDGE_ADDRESSES.GC_OMNIBRIDGE,
    abi: [
      parseAbiItem(
        "function relayTokens(address token, address _receiver, uint256 _value)",
      ),
    ],
    functionName: "relayTokens",
    args: [BRIDGE_ADDRESSES.GC_GNO, account.address, BRIDGE_AMOUNT],
  });
  const relayTx = await gnoClient.writeContract(relayReq);
  const relayReceipt = await gnoClient.getTransactionReceipt({ hash: relayTx });
  console.log(
    `Relay tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${relayTx}`,
  );

  // 4. Verify relay transaction succeeded
  assert(relayReceipt.status === "success", "Relay transaction succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in relay transaction");

  // 5. Verify GNO balance deducted on GC
  const midGnoGC = await getErc20Balance(
    gnoClient,
    BRIDGE_ADDRESSES.GC_GNO,
    account.address,
  );
  assert(
    midGnoGC < initialGnoGC,
    `GNO balance deducted on GC: ${initialGnoGC} -> ${midGnoGC}`,
  );

  if (!autoclaim) {
    // 5a. Recover message from AMB UserRequestForSignature event
    console.log("\nRecovering message from relay receipt...");
    const ambEventAbi = [
      parseAbiItem(
        "event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)",
      ),
    ];
    const ambLogs = parseEventLogs({
      abi: ambEventAbi,
      eventName: "UserRequestForSignature",
      logs: relayReceipt.logs,
    });
    if (ambLogs.length === 0) {
      throw new Error(
        "No AMB UserRequestForSignature event found in relay receipt",
      );
    }
    const message = ambLogs[0].args.encodedData;
    console.log(
      `Recovered message (messageId: ${ambLogs[0].args.messageId})`,
    );

    // 5b. Wait for validators to sign
    await waitForNextBlock(gnoClient);

    // 5c. Get signatures from AMBBridgeHelper on Gnosis Chain
    const AMB_BRIDGE_HELPER = "0x7d94ece17e81355326e3359115D4B02411825EdD";
    console.log("\nGetting signatures from AMBBridgeHelper...");
    const signatures = await gnoClient.readContract({
      address: AMB_BRIDGE_HELPER,
      abi: [
        parseAbiItem(
          "function getSignatures(bytes _message) returns (bytes)",
        ),
      ],
      functionName: "getSignatures",
      args: [message],
    });
    console.log("Signatures recovered from AMBBridgeHelper");

    // 5d. Execute claim on Ethereum via ForeignBridgeRouter
    console.log("\nClaiming on Ethereum via ForeignBridgeRouter...");
    const { request: claimReq } = await ethClient.simulateContract({
      address: BRIDGE_ADDRESSES.BRIDGE_ROUTER,
      abi: [
        parseAbiItem(
          "function safeExecuteSignaturesWithAutoGasLimit(bytes _data, bytes _signatures)",
        ),
      ],
      functionName: "safeExecuteSignaturesWithAutoGasLimit",
      args: [message, signatures],
    });
    const claimTx = await ethClient.writeContract(claimReq);
    const claimReceipt = await ethClient.getTransactionReceipt({
      hash: claimTx,
    });
    console.log(
      `Claim tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${claimTx}`,
    );
    assert(claimReceipt.status === "success", "Claim transaction succeeded");
  }

  // 6. Poll for GNO balance increase on ETH
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
    if (finalGnoETH > initialGnoETH) break;
  }
  assert(
    finalGnoETH > initialGnoETH,
    `GNO balance increased on ETH: ${initialGnoETH} -> ${finalGnoETH}`,
  );

  console.log("\n=== Test 2.4 PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 2.4 FAILED ===", err);
  process.exitCode = 1;
});
