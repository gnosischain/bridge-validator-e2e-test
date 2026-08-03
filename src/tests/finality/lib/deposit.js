// Layer-B deposit primitive — the "approve → relayTokens → capture receipt
// block" prefix shared by the existing tests, extracted so finality drivers can
// reuse it. Returns the relay tx + the block it mined in (the block whose
// finality the block-finality / fcr modes gate on).

import { parseAbiItem, parseEventLogs } from "viem";

// approve `amount` of `token` to `bridge`, then relayTokens → receipt.
// Returns { relayTx, blockNumber, receipt }.
export async function deposit({ client, token, bridge, receiver, amount, explorerUrl }) {
  const { request: approveReq } = await client.simulateContract({
    address: token,
    abi: [parseAbiItem("function approve(address spender, uint256 amount)")],
    functionName: "approve",
    args: [bridge, amount],
  });
  const approveTx = await client.writeContract(approveReq);
  if (explorerUrl) console.log(`  approve tx: ${explorerUrl}/tx/${approveTx}`);

  const { request: relayReq } = await client.simulateContract({
    address: bridge,
    abi: [
      parseAbiItem(
        "function relayTokens(address token, address _receiver, uint256 _value)",
      ),
    ],
    functionName: "relayTokens",
    args: [token, receiver, amount],
  });
  const relayTx = await client.writeContract(relayReq);
  const receipt = await client.getTransactionReceipt({ hash: relayTx });
  if (explorerUrl) console.log(`  relay tx:   ${explorerUrl}/tx/${relayTx}`);

  if (receipt.status !== "success") {
    throw new Error(`relayTokens reverted (tx ${relayTx})`);
  }
  return { relayTx, blockNumber: Number(receipt.blockNumber), receipt };
}

// Extract the AMB/Omnibridge UserRequestForSignature message (encodedData) from
// a GC-side relay receipt. This is what a validator signs; its presence in
// AMBBridgeHelper.getSignatures is the on-chain attestation signal.
export function extractAMBMessage(receipt) {
  const logs = parseEventLogs({
    abi: [
      parseAbiItem(
        "event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)",
      ),
    ],
    eventName: "UserRequestForSignature",
    logs: receipt.logs,
  });
  if (logs.length === 0) {
    throw new Error("No AMB UserRequestForSignature event in relay receipt");
  }
  return { message: logs[0].args.encodedData, messageId: logs[0].args.messageId };
}

// True once the validator has signed `message` (getSignatures returns non-empty).
// Reverts / returns "0x" before the validator attests → treated as not-signed.
const AMB_BRIDGE_HELPER = "0x7d94ece17e81355326e3359115D4B02411825EdD";
export async function isMessageSigned(gnoClient, message, ambHelper = AMB_BRIDGE_HELPER) {
  try {
    const signatures = await gnoClient.readContract({
      address: ambHelper,
      abi: [parseAbiItem("function getSignatures(bytes _message) returns (bytes)")],
      functionName: "getSignatures",
      args: [message],
    });
    return Boolean(signatures) && signatures !== "0x";
  } catch {
    return false;
  }
}
