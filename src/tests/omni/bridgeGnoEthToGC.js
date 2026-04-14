// Test 2.3: GNO on ETH -> GNO on GC via Omnibridge
import { createWalletClient, http, publicActions, parseAbiItem, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import BRIDGE_ADDRESSES from "../../utils/constant.js";
import { virtual_mainnet, virtual_gnosis, validateRpcUrls } from "../../utils/viemClientAndNetwork.js";
import { assert, getErc20Balance, waitForBalanceChange } from "../../utils/validator.js";

validateRpcUrls();

const account = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const ethClient = createWalletClient({ account, chain: virtual_mainnet, transport: http() }).extend(publicActions);
const gnoClient = createWalletClient({ account, chain: virtual_gnosis, transport: http() }).extend(publicActions);

const BRIDGE_AMOUNT = parseEther("1");

async function main() {
  console.log("=== Test 2.3: GNO on ETH -> GNO on GC ===\n");

  // 1. Record initial GNO balance on GC
  const initialGnoGC = await getErc20Balance(gnoClient, BRIDGE_ADDRESSES.GC_GNO, account.address);
  console.log(`Initial GNO balance (GC): ${initialGnoGC}`);

  // 2. Approve GNO to Omnibridge on ETH
  console.log("\nApproving GNO to Omnibridge...");
  const { request: approveReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.GNO,
    abi: [parseAbiItem("function approve(address spender, uint256 amount)")],
    functionName: "approve",
    args: [BRIDGE_ADDRESSES.OMNIBRIDGE, BRIDGE_AMOUNT],
  });
  const approveTx = await ethClient.writeContract(approveReq);
  console.log(`Approve tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${approveTx}`);

  // 3. Relay GNO via Omnibridge
  console.log("\nRelaying GNO via Omnibridge...");
  const { request: relayReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.OMNIBRIDGE,
    abi: [parseAbiItem("function relayTokens(address token, address _receiver, uint256 _value)")],
    functionName: "relayTokens",
    args: [BRIDGE_ADDRESSES.GNO, account.address, BRIDGE_AMOUNT],
  });
  const relayTx = await ethClient.writeContract(relayReq);
  const relayReceipt = await ethClient.getTransactionReceipt({ hash: relayTx });
  console.log(`Relay tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${relayTx}`);

  // 4. Verify relay transaction succeeded
  assert(relayReceipt.status === "success", "Relay transaction succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in relay transaction");

  // 5. Verify GNO balance deducted on ETH
  const finalGnoETH = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.GNO, account.address);
  console.log(`GNO balance after relay (ETH): ${finalGnoETH}`);

  // 6. Wait for GNO balance to increase on GC
  console.log("\nWaiting for bridge validator to relay to Gnosis Chain...");
  const finalGnoGC = await waitForBalanceChange(
    gnoClient,
    account.address,
    BRIDGE_ADDRESSES.GC_GNO,
    initialGnoGC,
  );
  assert(finalGnoGC > initialGnoGC, `GNO balance increased on GC: ${initialGnoGC} -> ${finalGnoGC}`);

  console.log("\n=== Test 2.3 PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 2.3 FAILED ===", err);
  process.exitCode = 1;
});
