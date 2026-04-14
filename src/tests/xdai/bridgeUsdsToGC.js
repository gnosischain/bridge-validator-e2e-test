// Test 1.1: USDS on ETH -> xDAI on GC via BridgeRouter
import { createWalletClient, http, publicActions, parseAbiItem, parseEther, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import BRIDGE_ADDRESSES from "../../utils/constant.js";
import { virtual_mainnet, virtual_gnosis, validateRpcUrls } from "../../utils/viemClientAndNetwork.js";
import { assert, getErc20Balance, waitForAddedReceiverEvent } from "../../utils/validator.js";

validateRpcUrls();

const account = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const ethClient = createWalletClient({ account, chain: virtual_mainnet, transport: http() }).extend(publicActions);
const gnoClient = createWalletClient({ account, chain: virtual_gnosis, transport: http() }).extend(publicActions);

const BRIDGE_AMOUNT = parseEther("1");

async function main() {
  console.log("=== Test 1.1: USDS on ETH -> xDAI on GC ===\n");

  // 1. Record initial USDS balance on ETH
  const initialUsds = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.USDS, account.address);
  console.log(`Initial USDS balance (ETH): ${initialUsds}`);

  // 2. Approve USDS to BridgeRouter
  console.log("\nApproving USDS to BridgeRouter...");
  const { request: approveReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.USDS,
    abi: [parseAbiItem("function approve(address spender, uint256 amount)")],
    functionName: "approve",
    args: [BRIDGE_ADDRESSES.BRIDGE_ROUTER, BRIDGE_AMOUNT],
  });
  const approveTx = await ethClient.writeContract(approveReq);
  console.log(`Approve tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${approveTx}`);

  // 3. BridgeRouter.relayTokens(USDS, recipient, amount)
  console.log("\nRelaying USDS via BridgeRouter...");
  const { request: relayReq } = await ethClient.simulateContract({
    address: BRIDGE_ADDRESSES.BRIDGE_ROUTER,
    abi: [parseAbiItem("function relayTokens(address token, address recipient, uint256 amount)")],
    functionName: "relayTokens",
    args: [BRIDGE_ADDRESSES.USDS, account.address, BRIDGE_AMOUNT],
  });
  const relayTx = await ethClient.writeContract(relayReq);
  const relayReceipt = await ethClient.getTransactionReceipt({ hash: relayTx });
  console.log(`Relay tx: ${virtual_mainnet.blockExplorers.default.url}/tx/${relayTx}`);

  // 4. Verify events emitted
  assert(relayReceipt.status === "success", "Relay transaction succeeded");
  assert(relayReceipt.logs.length > 0, "Events emitted in relay transaction");

  // 5. Verify USDS balance deducted on ETH
  const finalUsds = await getErc20Balance(ethClient, BRIDGE_ADDRESSES.USDS, account.address);
  assert(finalUsds < initialUsds, `USDS balance deducted on ETH: ${initialUsds} -> ${finalUsds}`);

  // 6. Wait for AddedReceiver event on Block Reward contract (validator processes affirmation)
  console.log("\nWaiting for bridge validator to relay to Gnosis Chain...");
  const blockBeforeRelay = await gnoClient.getBlockNumber();
  const addedReceiverLog = await waitForAddedReceiverEvent(
    gnoClient,
    BRIDGE_ADDRESSES.BLOCK_REWARD,
    account.address,
    BRIDGE_ADDRESSES.XDAI_HOME_BRIDGE,
    blockBeforeRelay,
  );
  assert(addedReceiverLog.args.amount > 0n, `AddedReceiver amount: ${addedReceiverLog.args.amount}`);

  console.log("\n=== Test 1.1 PASSED ===");
}

main().catch((err) => {
  console.error("\n=== Test 1.1 FAILED ===", err);
  process.exitCode = 1;
});
