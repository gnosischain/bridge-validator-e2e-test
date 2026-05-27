// Test 1.3: xDAI on GC -> USDS on ETH via USDS Deposit Contract
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
// Accept --autoclaim from a direct `node` arg as well as npm's captured
// `npm run ... --autoclaim` form (exposed as npm_config_autoclaim).
const autoclaim =
  process.argv.includes("--autoclaim") ||
  process.env.npm_config_autoclaim === "true";

async function main() {
  console.log("=== Test 1.3: xDAI on GC -> USDS on ETH ===\n");
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

  // 2. Call USDS Deposit Contract relayTokens (sends xDAI, receives USDS on ETH)
  console.log("\nRelaying xDAI via USDS Deposit Contract...");
  const { request: relayReq } = await gnoClient.simulateContract({
    address: BRIDGE_ADDRESSES.USDS_DEPOSIT_CONTRACT,
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
    // 5. Wait for validator signatures and collect them

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

  // 7. Verify USDS balance increased on ETH (poll up to 5 times, 12s apart)
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
    if (finalUsds > initialUsds) break;
  }
  assert(
    finalUsds > initialUsds,
    `USDS balance increased on ETH: ${initialUsds} -> ${finalUsds}`,
  );

  console.log("\n=== Test 1.3 PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 1.3 FAILED ===", err);
  process.exitCode = 1;
});
