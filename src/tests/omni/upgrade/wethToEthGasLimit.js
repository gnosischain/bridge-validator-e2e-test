// WETH (Gnosis Chain) -> ETH (Ethereum), exercised through every ForeignAMB relay path.
//
// This is the post-upgrade regression test for the WETH grief fixed in the new ForeignOmnibridge
// implementation. The griefable path is a claim routed through WETHOmnibridgeRouter: the AMB
// message hands the WETH to the router, and the router's `onTokenBridged` callback unwraps it and
// forwards native ETH to the real recipient. Pre-fix, BasicOmnibridge invoked that callback with a
// bare `.call` and ignored the result, so a caller who forwarded just enough gas for the mediator
// but not for the callback left the WETH stranded in the router with the message burnt as relayed.
//
// Post-fix the outcome is binary on every path:
//
//   safeExecuteSignaturesWithGasLimit(low)   -> whole tx reverts, message stays replayable
//   safeExecuteSignaturesWithGasLimit(high)  -> recipient receives native ETH
//   safeExecuteSignaturesWithAutoGasLimit    -> recipient receives native ETH
//   executeSignatures (honest header gas)    -> recipient receives native ETH
//   executeSignatures (starved header gas)   -> recorded as a FAILED message, nothing released,
//                                               requestFailedMessageFix reopens the refund path
//
//   node src/tests/omni/upgrade/wethToEthGasLimit.js
//
import axios from "axios";
import {
  concat,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  formatEther,
  getAddress,
  http,
  keccak256,
  numberToHex,
  parseAbiItem,
  parseEther,
  parseEventLogs,
  publicActions,
  size,
  slice,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { ETHEREUM, GNOSIS } from "../../../utils/constant.js";
import {
  virtual_mainnet,
  virtual_gnosis,
  validateRpcUrls,
} from "../../../utils/viemClientAndNetwork.js";
import { assert, getErc20Balance } from "../../../utils/validator.js";

validateRpcUrls();

// WETHOmnibridgeRouter on Ethereum — the unwrap hop that made the grief possible.
const WETH_ROUTER = getAddress("0xa6439Ca0FCbA1d0F80df0bE6A17220feD9c9038a");
const NEW_FOREIGN_IMPL = getAddress(
  process.env.NEW_FOREIGN_OMNIBRIDGE_IMPL ||
    "0x00e7097e9c1ce7121fc466ff31a7c742d5a26ea2",
);

const ETH_AMB = getAddress(ETHEREUM.AMB_BRIDGE);
const ETH_OMNIBRIDGE = getAddress(ETHEREUM.OMNIBRIDGE);
const ETH_WETH = getAddress(ETHEREUM.WETH);
const ETH_AMB_VALIDATORS = getAddress(ETHEREUM.AMB_VALIDATOR_MANAGEMENT);
const GC_OMNIBRIDGE = getAddress(GNOSIS.OMNIBRIDGE);
const GC_WETH = getAddress(GNOSIS.WETH);
const HOME_OMNIBRIDGE = GC_OMNIBRIDGE;

const AMOUNT = parseEther(process.env.WETH_TEST_AMOUNT || "0.05");
// Gas forwarded to the mediator. Measured on this fork for a 0.05 WETH claim into a *clean*
// router (its WETH balance slot at zero — the preflight asserts that, because a non-zero slot
// saves ~15k gas and shifts the whole band down):
//     <  90_000            the mediator itself runs out of gas    -> revert, before and after
//     90_000 .. 130_000    the grief band: pre-fix this stranded the WETH in the router with the
//                          message burnt as relayed; post-fix the guard turns it into a revert
//     >= 140_000           enough for the unwrap                  -> delivers, before and after
// LOW_GAS sits in the middle of the band, HIGH_GAS comfortably past the top of it.
const LOW_GAS = Number(process.env.WETH_LOW_GAS || 110000);
const HIGH_GAS = Number(process.env.WETH_HIGH_GAS || 400000);
// Header gasLimit for the crafted message — the value plain executeSignatures honours.
const GRIEF_HEADER_GAS = Number(process.env.WETH_GRIEF_HEADER_GAS || 110000);
const TX_GAS = 2000000n;

const alice = privateKeyToAccount(process.env.USER_PRIVATE_KEY);
const validator = privateKeyToAccount(process.env.VALIDATOR_PRIVATE_KEY);

const ethClient = createWalletClient({
  account: alice,
  chain: virtual_mainnet,
  transport: http(),
}).extend(publicActions);
const gnoClient = createWalletClient({
  account: alice,
  chain: virtual_gnosis,
  transport: http(),
}).extend(publicActions);

const ambAbi = [
  parseAbiItem("function executeSignatures(bytes _data, bytes _signatures)"),
  parseAbiItem(
    "function safeExecuteSignatures(bytes _data, bytes _signatures)",
  ),
  parseAbiItem(
    "function safeExecuteSignaturesWithGasLimit(bytes _data, bytes _signatures, uint32 _gas)",
  ),
  parseAbiItem(
    "function safeExecuteSignaturesWithAutoGasLimit(bytes _data, bytes _signatures)",
  ),
  parseAbiItem("function relayedMessages(bytes32) view returns (bool)"),
  parseAbiItem("function messageCallStatus(bytes32) view returns (bool)"),
  parseAbiItem(
    "function failedMessageReceiver(bytes32) view returns (address)",
  ),
  parseAbiItem("function failedMessageSender(bytes32) view returns (address)"),
];

const tokensBridgedEvent = parseAbiItem(
  "event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId)",
);
const relayedMessageEvent = parseAbiItem(
  "event RelayedMessage(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)",
);
const userRequestForSignatureEvent = parseAbiItem(
  "event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)",
);

// ─── Message helpers ────────────────────────────────────────────────────────
// AMB ArbitraryMessage layout:
//   [0:32] messageId | [32:52] sender | [52:72] executor | [72:76] gasLimit (uint32)
//   [76] srcChainIdLen | [77] dstChainIdLen | [78] dataType | srcChainId | dstChainId | data
const HEADER_GAS_OFFSET = 72;

function messageIdOf(message) {
  return slice(message, 0, 32);
}

function headerGasLimitOf(message) {
  return Number(
    BigInt(slice(message, HEADER_GAS_OFFSET, HEADER_GAS_OFFSET + 4)),
  );
}

// Rebuild a message with a different nonce (low 8 bytes of the messageId) and header gasLimit,
// keeping the real version prefix, bridgeId, sender, executor and payload intact. Used to get an
// AMB-valid message whose header starves the mediator — something a real relay never produces.
function craftMessage(template, { nonce, headerGasLimit }) {
  const messageId = concat([
    slice(template, 0, 24),
    numberToHex(nonce, { size: 8 }),
  ]);
  return concat([
    messageId,
    slice(template, 32, HEADER_GAS_OFFSET),
    numberToHex(headerGasLimit, { size: 4 }),
    slice(template, HEADER_GAS_OFFSET + 4, size(template)),
  ]);
}

async function signAsValidator(message) {
  const signature = await validator.signMessage({ message: { raw: message } });
  const r = slice(signature, 0, 32);
  const s = slice(signature, 32, 64);
  const v = slice(signature, 64, 65);
  return concat(["0x01", v, r, s]);
}

// ─── Transaction helpers ────────────────────────────────────────────────────
async function sendAmb(functionName, args, { label }) {
  const data = encodeFunctionData({ abi: ambAbi, functionName, args });
  const hash = await ethClient.sendTransaction({
    to: ETH_AMB,
    data,
    gas: TX_GAS,
  });
  const receipt = await ethClient.waitForTransactionReceipt({ hash });
  console.log(`  ${label} tx: ${hash} (status: ${receipt.status})`);
  return receipt;
}

// Establish the revert with eth_call first (deterministic), then still land the transaction so the
// failure is visible on chain. Some nodes reject a reverting tx at submission instead of mining it;
// both outcomes count as a revert, anything else does not.
async function sendAmbExpectingRevert(functionName, args, { label }) {
  const data = encodeFunctionData({ abi: ambAbi, functionName, args });

  let simulationReverted = false;
  try {
    await ethClient.call({ account: alice, to: ETH_AMB, data, gas: TX_GAS });
  } catch (err) {
    simulationReverted = true;
    console.log(
      `  ${label}: eth_call reverted (${err.shortMessage || err.message})`,
    );
  }
  assert(simulationReverted, `${label}: call reverts instead of settling`);

  try {
    const hash = await ethClient.sendTransaction({
      to: ETH_AMB,
      data,
      gas: TX_GAS,
    });
    const receipt = await ethClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label} tx: ${hash} (status: ${receipt.status})`);
    assert(
      receipt.status === "reverted",
      `${label}: transaction reverted on chain`,
    );
  } catch (err) {
    const message =
      `${err.shortMessage || ""} ${err.message || ""}`.toLowerCase();
    if (!message.includes("revert")) throw err;
    console.log(
      `  ${label}: node rejected the reverting tx at submission — counted as a revert`,
    );
  }
}

// ─── Bridging ───────────────────────────────────────────────────────────────
// Relay GC WETH to the Ethereum WETHOmnibridgeRouter with the real recipient as the callback
// payload. On Ethereum this becomes handleNativeTokensAndCall(WETH, router, value, recipient).
async function relayWethToRouter(recipient) {
  const { request } = await gnoClient.simulateContract({
    address: GC_OMNIBRIDGE,
    abi: [
      parseAbiItem(
        "function relayTokensAndCall(address token, address _receiver, uint256 _value, bytes _data)",
      ),
    ],
    functionName: "relayTokensAndCall",
    args: [GC_WETH, WETH_ROUTER, AMOUNT, recipient],
  });
  const hash = await gnoClient.writeContract(request);
  const receipt = await gnoClient.waitForTransactionReceipt({ hash });
  assert(
    receipt.status === "success",
    `GC relay for ${recipient} succeeded (${hash})`,
  );

  const logs = parseEventLogs({
    abi: [userRequestForSignatureEvent],
    eventName: "UserRequestForSignature",
    logs: receipt.logs,
  });
  assert(
    logs.length === 1,
    "GC relay emitted exactly one UserRequestForSignature",
  );

  const message = logs[0].args.encodedData;
  const messageId = logs[0].args.messageId;
  console.log(
    `  messageId ${messageId}, header gasLimit ${headerGasLimitOf(message)}`,
  );
  await ensureMessageReplayable(messageId);
  return { message, messageId };
}

async function ambRead(functionName, args) {
  return ethClient.readContract({
    address: ETH_AMB,
    abi: ambAbi,
    functionName,
    args,
  });
}

// The Gnosis fork keeps handing out AMB nonces the real bridge has already used, and the Ethereum
// fork inherits mainnet state — so a freshly minted messageId is often already marked relayed here.
// Clear the two EternalStorage bool slots (boolStorage is slot 4, keys are
// keccak256(name || messageId)) so the fork can execute the message. Same workaround as
// overrideRelayedMessagesIfNeeded in src/utils/validator.js, extended to messageCallStatus.
async function ensureMessageReplayable(messageId) {
  if (!(await ambRead("relayedMessages", [messageId]))) return;

  console.log(
    `  ${messageId} is already relayed on the fork — clearing AMB storage...`,
  );
  for (const name of ["relayedMessages", "messageCallStatus"]) {
    const slot = keccak256(
      encodePacked(
        ["bytes32", "uint256"],
        [keccak256(encodePacked(["string", "bytes32"], [name, messageId])), 4n],
      ),
    );
    const { data } = await axios.post(process.env.TENDERLY_ETHEREUM_ADMIN_RPC, {
      id: 1,
      jsonrpc: "2.0",
      method: "tenderly_setStorageAt",
      params: [ETH_AMB, slot, `0x${"0".repeat(64)}`],
    });
    if (data.error)
      throw new Error(`tenderly_setStorageAt: ${JSON.stringify(data.error)}`);
  }

  assert(
    (await ambRead("relayedMessages", [messageId])) === false,
    `${messageId}: relayedMessages cleared, message is replayable`,
  );
}

const wethBalance = (address) => getErc20Balance(ethClient, ETH_WETH, address);

function newRecipient() {
  return privateKeyToAccount(generatePrivateKey()).address;
}

async function assertDelivered({
  label,
  receipt,
  messageId,
  recipient,
  bridgeWethBefore,
}) {
  assert(receipt.status === "success", `${label}: claim transaction succeeded`);

  const bridged = parseEventLogs({
    abi: [tokensBridgedEvent],
    eventName: "TokensBridged",
    logs: receipt.logs,
  });
  assert(
    bridged.some(
      (log) => log.args.messageId === messageId && log.args.value === AMOUNT,
    ),
    `${label}: TokensBridged emitted for ${messageId}`,
  );
  const relayed = parseEventLogs({
    abi: [relayedMessageEvent],
    eventName: "RelayedMessage",
    logs: receipt.logs,
  });
  assert(
    relayed.some(
      (log) => log.args.messageId === messageId && log.args.status === true,
    ),
    `${label}: RelayedMessage(status=true) emitted`,
  );

  assert(
    (await ethClient.getBalance({ address: recipient })) === AMOUNT,
    `${label}: recipient received ${formatEther(AMOUNT)} native ETH`,
  );
  assert(
    (await wethBalance(recipient)) === 0n,
    `${label}: recipient holds no WETH (it was unwrapped)`,
  );
  assert(
    (await wethBalance(WETH_ROUTER)) === 0n,
    `${label}: nothing stranded in the router`,
  );
  assert(
    (await wethBalance(ETH_OMNIBRIDGE)) === bridgeWethBefore - AMOUNT,
    `${label}: bridge released exactly ${formatEther(AMOUNT)} WETH`,
  );
  assert(
    await ambRead("relayedMessages", [messageId]),
    `${label}: message marked relayed`,
  );
  assert(
    await ambRead("messageCallStatus", [messageId]),
    `${label}: message call recorded as success`,
  );
}

// ─── Preflight ──────────────────────────────────────────────────────────────
async function preflight() {
  console.log("\n--- Preflight ---");

  const implementation = await ethClient.readContract({
    address: ETH_OMNIBRIDGE,
    abi: [parseAbiItem("function implementation() view returns (address)")],
    functionName: "implementation",
  });
  assert(
    getAddress(implementation) === NEW_FOREIGN_IMPL,
    `ForeignOmnibridge runs the new implementation ${NEW_FOREIGN_IMPL} (run upgradeOmnibridge.js first)`,
  );

  assert(
    await ethClient.readContract({
      address: ETH_AMB_VALIDATORS,
      abi: [parseAbiItem("function isValidator(address) view returns (bool)")],
      functionName: "isValidator",
      args: [validator.address],
    }),
    `Test validator ${validator.address} is registered on the Foreign AMB`,
  );
  const requiredSignatures = await ethClient.readContract({
    address: ETH_AMB_VALIDATORS,
    abi: [parseAbiItem("function requiredSignatures() view returns (uint256)")],
    functionName: "requiredSignatures",
  });
  assert(requiredSignatures === 1n, "Foreign AMB requiredSignatures == 1");

  assert(
    getAddress(
      await ethClient.readContract({
        address: WETH_ROUTER,
        abi: [parseAbiItem("function bridge() view returns (address)")],
        functionName: "bridge",
      }),
    ) === ETH_OMNIBRIDGE,
    `WETHOmnibridgeRouter ${WETH_ROUTER} points at the Foreign Omnibridge`,
  );
  assert(
    (await wethBalance(WETH_ROUTER)) === 0n,
    "WETHOmnibridgeRouter starts with no stranded WETH",
  );

  const aliceWeth = await getErc20Balance(gnoClient, GC_WETH, alice.address);
  assert(
    aliceWeth >= AMOUNT * 4n,
    `Alice holds enough GC WETH for 4 relays: ${formatEther(aliceWeth)} >= ${formatEther(AMOUNT * 4n)}`,
  );

  console.log("\nApproving GC WETH to the Home Omnibridge...");
  const { request } = await gnoClient.simulateContract({
    address: GC_WETH,
    abi: [parseAbiItem("function approve(address spender, uint256 amount)")],
    functionName: "approve",
    args: [GC_OMNIBRIDGE, AMOUNT * 4n],
  });
  const approveReceipt = await gnoClient.waitForTransactionReceipt({
    hash: await gnoClient.writeContract(request),
  });
  assert(approveReceipt.status === "success", "GC WETH approval succeeded");
}

// ─── Cases ──────────────────────────────────────────────────────────────────

// safeExecuteSignaturesWithGasLimit: starved gas must revert outright and leave the message
// replayable; the same message then settles with an honest gas limit.
async function caseGasLimitLowThenHigh() {
  console.log(
    "\n--- Case 1: safeExecuteSignaturesWithGasLimit (low -> revert, high -> pass) ---",
  );
  const recipient = newRecipient();
  console.log(`  recipient: ${recipient}`);
  const { message, messageId } = await relayWethToRouter(recipient);
  const signatures = await signAsValidator(message);

  const bridgeWethBefore = await wethBalance(ETH_OMNIBRIDGE);

  console.log(
    `\n  Claiming with _gas = ${LOW_GAS} (inside the old grief band)...`,
  );
  await sendAmbExpectingRevert(
    "safeExecuteSignaturesWithGasLimit",
    [message, signatures, LOW_GAS],
    { label: `low gas (${LOW_GAS})` },
  );
  assert(
    (await wethBalance(ETH_OMNIBRIDGE)) === bridgeWethBefore,
    "low gas: no WETH left the bridge",
  );
  assert(
    (await wethBalance(WETH_ROUTER)) === 0n,
    "low gas: nothing stranded in the router",
  );
  assert(
    (await ethClient.getBalance({ address: recipient })) === 0n,
    "low gas: recipient received nothing",
  );
  assert(
    (await ambRead("relayedMessages", [messageId])) === false,
    "low gas: message stays replayable",
  );

  console.log(`\n  Re-claiming the same message with _gas = ${HIGH_GAS}...`);
  const receipt = await sendAmb(
    "safeExecuteSignaturesWithGasLimit",
    [message, signatures, HIGH_GAS],
    { label: `high gas (${HIGH_GAS})` },
  );
  await assertDelivered({
    label: `high gas (${HIGH_GAS})`,
    receipt,
    messageId,
    recipient,
    bridgeWethBefore,
  });
}

async function caseAutoGasLimit() {
  console.log("\n--- Case 2: safeExecuteSignaturesWithAutoGasLimit (pass) ---");
  const recipient = newRecipient();
  console.log(`  recipient: ${recipient}`);
  const { message, messageId } = await relayWethToRouter(recipient);
  const signatures = await signAsValidator(message);

  const bridgeWethBefore = await wethBalance(ETH_OMNIBRIDGE);
  const receipt = await sendAmb(
    "safeExecuteSignaturesWithAutoGasLimit",
    [message, signatures],
    { label: "autoGasLimit" },
  );
  await assertDelivered({
    label: "autoGasLimit",
    receipt,
    messageId,
    recipient,
    bridgeWethBefore,
  });
}

async function caseExecuteSignaturesPass() {
  console.log(
    "\n--- Case 3: executeSignatures with the bridge's own header gasLimit (pass) ---",
  );
  const recipient = newRecipient();
  console.log(`  recipient: ${recipient}`);
  const { message, messageId } = await relayWethToRouter(recipient);
  const signatures = await signAsValidator(message);

  const bridgeWethBefore = await wethBalance(ETH_OMNIBRIDGE);
  const receipt = await sendAmb("executeSignatures", [message, signatures], {
    label: "executeSignatures",
  });
  await assertDelivered({
    label: "executeSignatures",
    receipt,
    messageId,
    recipient,
    bridgeWethBefore,
  });
}

// executeSignatures does not revert on a failed mediator call — it records the failure. Post-fix
// that failure is a *real* failure (nothing released, nothing stranded), which is what reopens
// requestFailedMessageFix; pre-fix the same claim was recorded as a success with the WETH stuck.
async function caseExecuteSignaturesStarvedHeader() {
  console.log(
    "\n--- Case 4: executeSignatures with a starved header gasLimit (fail, recoverable) ---",
  );
  const recipient = newRecipient();
  console.log(`  recipient: ${recipient}`);
  const { message: template, messageId: templateId } =
    await relayWethToRouter(recipient);

  // Same payload, a nonce far above the live one, and a header gasLimit inside the grief band.
  const nonce = BigInt(slice(templateId, 24, 32)) + 0x10000000n;
  const crafted = craftMessage(template, {
    nonce,
    headerGasLimit: GRIEF_HEADER_GAS,
  });
  const craftedId = messageIdOf(crafted);
  console.log(
    `  crafted messageId ${craftedId}, header gasLimit ${headerGasLimitOf(crafted)}`,
  );
  assert(
    (await ambRead("relayedMessages", [craftedId])) === false,
    "crafted messageId has never been relayed",
  );
  const signatures = await signAsValidator(crafted);

  const bridgeWethBefore = await wethBalance(ETH_OMNIBRIDGE);
  const receipt = await sendAmb("executeSignatures", [crafted, signatures], {
    label: "starved header",
  });
  assert(
    receipt.status === "success",
    "starved header: relay tx itself succeeds",
  );

  const relayed = parseEventLogs({
    abi: [relayedMessageEvent],
    eventName: "RelayedMessage",
    logs: receipt.logs,
  });
  assert(
    relayed.some(
      (log) => log.args.messageId === craftedId && log.args.status === false,
    ),
    "starved header: RelayedMessage(status=false) emitted",
  );
  assert(
    (await wethBalance(ETH_OMNIBRIDGE)) === bridgeWethBefore,
    "starved header: no WETH left the bridge",
  );
  assert(
    (await wethBalance(WETH_ROUTER)) === 0n,
    "starved header: nothing stranded in the router",
  );
  assert(
    (await ethClient.getBalance({ address: recipient })) === 0n,
    "starved header: recipient received nothing",
  );
  assert(
    await ambRead("relayedMessages", [craftedId]),
    "starved header: message marked relayed",
  );
  assert(
    (await ambRead("messageCallStatus", [craftedId])) === false,
    "starved header: message call recorded as FAILED",
  );
  assert(
    getAddress(await ambRead("failedMessageReceiver", [craftedId])) ===
      ETH_OMNIBRIDGE,
    "starved header: failed receiver is the Foreign Omnibridge",
  );
  assert(
    getAddress(await ambRead("failedMessageSender", [craftedId])) ===
      getAddress(HOME_OMNIBRIDGE),
    "starved header: failed sender is the Home Omnibridge",
  );

  // The refund path is open: this asks the Home mediator to return the tokens to the sender.
  console.log("\n  requestFailedMessageFix on the Foreign Omnibridge...");
  const { request } = await ethClient.simulateContract({
    address: ETH_OMNIBRIDGE,
    abi: [parseAbiItem("function requestFailedMessageFix(bytes32 _messageId)")],
    functionName: "requestFailedMessageFix",
    args: [craftedId],
  });
  const fixReceipt = await ethClient.waitForTransactionReceipt({
    hash: await ethClient.writeContract(request),
  });
  assert(
    fixReceipt.status === "success",
    "starved header: requestFailedMessageFix succeeded",
  );
  assert(
    fixReceipt.logs.length > 0,
    "starved header: requestFailedMessageFix emitted the fix request to the AMB",
  );

  // The honest message from the same relay is untouched — claim it so nothing is left hanging.
  console.log("\n  Claiming the honest message from the same relay...");
  const honestSignatures = await signAsValidator(template);
  const bridgeWethBeforeHonest = await wethBalance(ETH_OMNIBRIDGE);
  const honestReceipt = await sendAmb(
    "safeExecuteSignaturesWithAutoGasLimit",
    [template, honestSignatures],
    { label: "honest follow-up" },
  );
  await assertDelivered({
    label: "honest follow-up",
    receipt: honestReceipt,
    messageId: templateId,
    recipient,
    bridgeWethBefore: bridgeWethBeforeHonest,
  });
}

async function main() {
  console.log(
    "=== WETH (GC) -> ETH (Ethereum): ForeignAMB relay paths after the upgrade ===",
  );
  console.log(`  amount: ${formatEther(AMOUNT)} WETH per relay`);
  console.log(`  alice:  ${alice.address}`);

  await preflight();
  await caseGasLimitLowThenHigh();
  await caseAutoGasLimit();
  await caseExecuteSignaturesPass();
  await caseExecuteSignaturesStarvedHeader();

  console.log("\n=== WETH GAS-LIMIT SUITE PASSED ===");
}

main().catch((err) => {
  console.error("\n=== WETH GAS-LIMIT SUITE FAILED ===", err);
  process.exitCode = 1;
});
