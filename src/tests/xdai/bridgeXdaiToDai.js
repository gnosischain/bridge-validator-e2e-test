// Test 1.4: xDAI on GC -> DAI on ETH via xDAI Home Bridge
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
  getXdaiSignaturesFromReceipt,
  claimOnForeignBridge,
  overrideRelayedMessagesIfNeeded,
} from "../../utils/validator.js";

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

const BRIDGE_AMOUNT = parseEther("10");
const autoclaim = process.argv.includes("--autoclaim");

async function main() {
  console.log("=== Test 1.4: xDAI on GC -> DAI on ETH ===\n");
  console.log(
    `  Mode: ${autoclaim ? "autoclaim (validator executes on foreign)" : "manual claim"}\n`,
  );

  // 1. Record initial balances
  const initialXdai = await gnoClient.getBalance({ address: account.address });
  const initialDai = await getErc20Balance(
    ethClient,
    BRIDGE_ADDRESSES.DAI,
    account.address,
  );
  console.log(`Initial xDAI balance (GC): ${initialXdai}`);
  console.log(`Initial DAI balance (ETH): ${initialDai}`);

  // 2. Call xDAI Home Bridge relayTokens (sends xDAI, receives DAI on ETH)
  console.log("\nRelaying xDAI via Home Bridge...");
  const { request: relayReq } = await gnoClient.simulateContract({
    address: BRIDGE_ADDRESSES.XDAI_HOME_BRIDGE,
    abi: [parseAbiItem("function relayTokens(address recipient)")],
    functionName: "relayTokens",
    args: [account.address],
    value: BRIDGE_AMOUNT,
    gas: 2000000n,
  });
  const relayTx = await gnoClient.writeContract(relayReq);
  const relayReceipt = await gnoClient.getTransactionReceipt({ hash: relayTx });
  console.log(
    `Relay tx: ${virtual_gnosis.blockExplorers.default.url}/tx/${relayTx}`,
  );

  // 3. Verify events emitted
  assert(relayReceipt.status === "success", "Relay transaction succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in relay transaction");

  // 4. Verify xDAI balance deducted on GC
  const midXdai = await gnoClient.getBalance({ address: account.address });
  assert(
    midXdai < initialXdai,
    `xDAI balance deducted on GC: ${initialXdai} -> ${midXdai}`,
  );

  if (!autoclaim) {
    // 5. Collect validator signatures

    console.log("\nWaiting for validator signatures...");
    const { message, signatures } = await getXdaiSignaturesFromReceipt(
      gnoClient,
      relayReceipt,
      BRIDGE_ADDRESSES.XDAI_HOME_BRIDGE,
    );

    // 6. Claim DAI on ETH
    console.log("\nClaiming DAI on Ethereum...");
    await claimOnForeignBridge(
      ethClient,
      BRIDGE_ADDRESSES.XDAI_FOREIGN_BRIDGE,
      message,
      signatures,
    );
  }

  console.log("\nWaiting for DAI balance to increase on ETH...");
  let finalDai = initialDai;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 12000));
    finalDai = await getErc20Balance(
      ethClient,
      BRIDGE_ADDRESSES.DAI,
      account.address,
    );
    console.log(`  Attempt ${attempt}/5: DAI balance = ${finalDai}`);
    if (finalDai > initialDai) break;
  }
  assert(
    finalDai > initialDai,
    `DAI balance increased on ETH: ${initialDai} -> ${finalDai}`,
  );

  console.log("\n=== Test 1.4 PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 1.4 FAILED ===", err);
  process.exitCode = 1;
});
