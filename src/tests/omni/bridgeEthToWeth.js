// Test 2.1: ETH on Ethereum -> WETH on GC via Omnibridge
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
  console.log("=== Test 2.1: ETH on Ethereum -> WETH on GC ===\n");

  // 1. Record initial WETH balance on GC
  const initialWethGC = await getErc20Balance(gnoClient, BRIDGE_ADDRESSES.GC_WETH, account.address);
  console.log(`Initial WETH balance (GC): ${initialWethGC}`);

  // 2. Wrap ETH to WETH on Ethereum
  console.log("\nWrapping ETH to WETH...");
  const { request: depositReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.WETH,
    abi: [parseAbiItem("function deposit() payable")],
    functionName: "deposit",
    value: BRIDGE_AMOUNT,
  });
  const depositTx = await ethClient.writeContract(depositReq);
  console.log(`Deposit tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${depositTx}`);

  // 3. Approve WETH to Omnibridge on ETH
  console.log("\nApproving WETH to Omnibridge...");
  const { request: approveReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.WETH,
    abi: [parseAbiItem("function approve(address spender, uint256 amount)")],
    functionName: "approve",
    args: [BRIDGE_ADDRESSES.OMNIBRIDGE, BRIDGE_AMOUNT],
  });
  const approveTx = await ethClient.writeContract(approveReq);
  console.log(`Approve tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${approveTx}`);

  // 4. Relay WETH via Omnibridge
  console.log("\nRelaying WETH via Omnibridge...");
  const { request: relayReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.OMNIBRIDGE,
    abi: [parseAbiItem("function relayTokens(address token, address _receiver, uint256 _value)")],
    functionName: "relayTokens",
    args: [BRIDGE_ADDRESSES.WETH, account.address, BRIDGE_AMOUNT],
  });
  const relayTx = await ethClient.writeContract(relayReq);
  const relayReceipt = await ethClient.getTransactionReceipt({ hash: relayTx });
  console.log(`Relay tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${relayTx}`);

  // 5. Verify relay transaction succeeded
  assert(relayReceipt.status === "success", "Relay transaction succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in relay transaction");

  // 6. Wait for WETH balance to increase on GC
  console.log("\nWaiting for bridge validator to relay to Gnosis Chain...");
  const finalWethGC = await waitForBalanceChange(
    gnoClient,
    account.address,
    BRIDGE_ADDRESSES.GC_WETH,
    initialWethGC,
  );
  assert(finalWethGC > initialWethGC, `WETH balance increased on GC: ${initialWethGC} -> ${finalWethGC}`);

  console.log("\n=== Test 2.1 PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 2.1 FAILED ===", err);
  process.exitCode = 1;
});
