// Multicall3 batching helpers built on viem's multicall3Abi.
//
// viem ships `multicall3Abi` (the read-path used by client.multicall), but it
// only contains `aggregate3`. To batch native-value relays (e.g. xDAI ->
// USDS/DAI) we also need the payable `aggregate3Value`, so we append that
// fragment here. Both helpers send a real state-changing transaction via
// writeContract (viem's `multicall` action is read-only and cannot bridge).
import { multicall3Abi, encodeFunctionData } from "viem";

// Canonical Multicall3 deployment (same address on Ethereum and Gnosis Chain).
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const aggregate3ValueFragment = {
  type: "function",
  name: "aggregate3Value",
  stateMutability: "payable",
  inputs: [
    {
      name: "calls",
      type: "tuple[]",
      components: [
        { name: "target", type: "address" },
        { name: "allowFailure", type: "bool" },
        { name: "value", type: "uint256" },
        { name: "callData", type: "bytes" },
      ],
    },
  ],
  outputs: [
    {
      name: "returnData",
      type: "tuple[]",
      components: [
        { name: "success", type: "bool" },
        { name: "returnData", type: "bytes" },
      ],
    },
  ],
};

export const MULTICALL3_ABI = [...multicall3Abi, aggregate3ValueFragment];

// Build a Call3 entry { target, allowFailure: false, callData }.
// `abi` is the target contract's ABI fragment(s); functionName/args encode the call.
export function call3(target, abi, functionName, args) {
  return {
    target,
    allowFailure: false,
    callData: encodeFunctionData({ abi, functionName, args }),
  };
}

// Build a Call3Value entry { target, allowFailure: false, value, callData }.
export function call3Value(target, value, abi, functionName, args) {
  return {
    target,
    allowFailure: false,
    value,
    callData: encodeFunctionData({ abi, functionName, args }),
  };
}

// Send a non-payable batch via Multicall3.aggregate3 and return the receipt.
// Pass an explicit `gas` limit for bridge relays whose gas is hard to estimate
// (Multicall3 forwards only 63/64 of remaining gas to each sub-call, so
// eth_estimateGas tends to come up short for batched bridge calls).
export async function sendAggregate3(client, calls, { gas } = {}) {
  console.log(`Sending Multicall3.aggregate3 with ${calls.length} call(s)...`);
  const { request } = await client.simulateContract({
    address: MULTICALL3_ADDRESS,
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [calls],
    ...(gas ? { gas } : {}),
  });
  const txHash = await client.writeContract(request);
  return client.getTransactionReceipt({ hash: txHash });
}

// Send a payable batch via Multicall3.aggregate3Value and return the receipt.
// totalValue must equal the sum of each call's `value`. See sendAggregate3 for
// why an explicit `gas` limit is usually required.
export async function sendAggregate3Value(client, calls, totalValue, { gas } = {}) {
  console.log(
    `Sending Multicall3.aggregate3Value with ${calls.length} call(s), value ${totalValue}...`,
  );
  const { request } = await client.simulateContract({
    address: MULTICALL3_ADDRESS,
    abi: MULTICALL3_ABI,
    functionName: "aggregate3Value",
    args: [calls],
    value: totalValue,
    ...(gas ? { gas } : {}),
  });
  const txHash = await client.writeContract(request);
  return client.getTransactionReceipt({ hash: txHash });
}
