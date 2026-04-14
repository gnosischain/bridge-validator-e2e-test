import {
  parseAbiItem,
  parseEventLogs,
  keccak256,
  encodePacked,
  concat,
  erc20Abi,
} from "viem";
import axios from "axios";

const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_ATTEMPTS = 60; // 5 minutes max

// Wait for next block to be mined on Tenderly VN
export async function waitForNextBlock(client) {
  const currentBlock = await client.getBlockNumber();
  console.log(`Current block: ${currentBlock}, waiting for next block...`);

  let latestBlock;
  do {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    latestBlock = await client.getBlockNumber();
    console.log(`Latest block: ${latestBlock}`);
  } while (latestBlock <= currentBlock);

  console.log(`New block confirmed: ${latestBlock}`);
  return latestBlock;
}

// Collect validator signatures from the home bridge / AMB contract on GC
export async function collectSignatures(client, bridgeAddress, messageHash) {
  console.log(
    `Collecting signatures from ${bridgeAddress} for hash ${messageHash}...`,
  );

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const numSigned = await client.readContract({
      address: bridgeAddress,
      abi: [
        parseAbiItem(
          "function numMessagesSigned(bytes32 _message) public view returns (uint256)",
        ),
      ],
      functionName: "numMessagesSigned",
      args: [messageHash],
    });

    // Top bit (2^255) indicates all required signatures collected
    const isFullySigned = numSigned >> 255n === 1n;
    const count = numSigned & ((1n << 255n) - 1n);

    console.log(
      `Signatures collected: ${count}, fully signed: ${isFullySigned}`,
    );

    if (isFullySigned && count > 0n) {
      const signatures = [];
      for (let i = 0n; i < count; i++) {
        const sig = await client.readContract({
          address: bridgeAddress,
          abi: [
            parseAbiItem(
              "function signature(bytes32 _hash, uint256 _index) public view returns (bytes)",
            ),
          ],
          functionName: "signature",
          args: [messageHash, i],
        });
        signatures.push(sig);
      }
      return concat(signatures);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error("Timeout waiting for validator signatures");
}

// Parse UserRequestForSignature event from xDAI home bridge receipt and collect signatures
export async function getXdaiSignaturesFromReceipt(
  client,
  receipt,
  homeBridgeAddress,
) {
  const UserRequestForSignatureEvent =
    "0xe1e0bc4a1db39a361e3589cae613d7b4862e1f9114dd3ff12ff45be395046968";
  const xDAIBridgeHelper = "0xe30269bc61E677cD60aD163a221e464B7022fbf5";

  const relevantLog = receipt.logs.find(
    (log) => log.topics[0] === UserRequestForSignatureEvent,
  );
  if (relevantLog) {
    console.log("Found UserRequestForSignature event");

    // Decode the log data
    // The data contains: recipient (address), value (uint256), nonce (bytes32), token (address)
    const decodedData = {
      recipient: `0x${relevantLog.data.slice(26, 66)}`,
      value: BigInt(`0x${relevantLog.data.slice(66, 130)}`),
      nonce: `0x${relevantLog.data.slice(130, 194)}`,
      token: `0x${relevantLog.data.slice(218, 258)}`,
    };
    await new Promise((resolve) => setTimeout(resolve, 10000));
    console.log("\nWaiting for 10s for bridge validator to process");
    // Mint 2 block on GC so the validator can process the message
    await axios.post(process.env.TENDERLY_GNOSIS_ADMIN_RPC, {
      id: 1,
      jsonrpc: "2.0",
      method: "evm_mine",
      params: [],
    });
    await axios.post(process.env.TENDERLY_GNOSIS_ADMIN_RPC, {
      id: 1,
      jsonrpc: "2.0",
      method: "evm_mine",
      params: [],
    });
    console.log("Mined 2 block on GC");

    // call xdai bridge helper

    const msgHash = await client.readContract({
      address: xDAIBridgeHelper,
      abi: [
        parseAbiItem(
          "function getMessageHash(address _recipient, uint256 _value, bytes32 _origTxHash, address _token) returns (bytes32)",
        ),
      ],
      functionName: "getMessageHash",
      args: [
        decodedData.recipient,
        decodedData.value,
        decodedData.nonce,
        decodedData.token,
      ],
    });
    console.log("Message Hash ", msgHash);
    const message = await client.readContract({
      address: xDAIBridgeHelper,
      abi: [
        parseAbiItem("function getMessage(bytes32 _msgHash) returns (bytes)"),
      ],
      functionName: "getMessage",
      args: [msgHash],
    });

    console.log("Message ", message);
    const signatures = await client.readContract({
      address: xDAIBridgeHelper,
      abi: [
        parseAbiItem(
          "function getSignatures(bytes32 _msgHash) returns (bytes)",
        ),
      ],
      functionName: "getSignatures",
      args: [msgHash],
    });

    console.log("signatures ", signatures);
    return { message, signatures };
  }
}

// Parse UserRequestForSignature event from AMB receipt and collect signatures
export async function getAMBSignaturesFromReceipt(client, receipt, ambAddress) {
  // The AMB emits UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)
  const eventAbi = [
    parseAbiItem(
      "event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)",
    ),
  ];

  const logs = parseEventLogs({
    abi: eventAbi,
    eventName: "UserRequestForSignature",
    logs: receipt.logs,
  });

  if (logs.length === 0) {
    throw new Error("No UserRequestForSignature event found in AMB receipt");
  }

  const message = logs[0].args.encodedData;
  const messageHash = keccak256(message);

  console.log(
    `Found AMB UserRequestForSignature event, messageId: ${logs[0].args.messageId}, messageHash: ${messageHash}`,
  );

  await waitForNextBlock(client);

  const signatures = await collectSignatures(client, ambAddress, messageHash);

  return { message, signatures, messageHash };
}

// Execute signatures on the foreign bridge (ETH) to claim tokens
export async function claimOnForeignBridge(
  ethClient,
  foreignBridgeAddress,
  message,
  signatures,
) {
  console.log(`Claiming on foreign bridge ${foreignBridgeAddress}...`);

  const { request } = await ethClient.simulateContract({
    address: foreignBridgeAddress,
    abi: [
      parseAbiItem(
        "function executeSignatures(bytes message, bytes signatures)",
      ),
    ],
    functionName: "executeSignatures",
    args: [message, signatures],
  });

  const txHash = await ethClient.writeContract(request);
  const receipt = await ethClient.getTransactionReceipt({ hash: txHash });

  console.log(
    `Claimed on foreign bridge, tx: ${txHash}, status: ${receipt.status}`,
  );
  return receipt;
}

// Override relayedMessages storage slot if already relayed (Tenderly VN workaround)
export async function overrideRelayedMessagesIfNeeded(
  ethClient,
  foreignBridgeAddress,
  nonce,
) {
  const isRelayed = await ethClient.readContract({
    address: foreignBridgeAddress,
    abi: [
      parseAbiItem(
        "function relayedMessages(bytes32 _txHash) public view returns (bool)",
      ),
    ],
    functionName: "relayedMessages",
    args: [nonce],
  });

  if (isRelayed) {
    console.log(`Message ${nonce} already relayed, overriding storage...`);

    // Compute storage slot for relayedMessages mapping
    // boolStorage mapping is at slot 4 in EternalStorage
    const storageSlot = keccak256(
      encodePacked(
        ["bytes32", "uint256"],
        [
          keccak256(
            encodePacked(["string", "bytes32"], ["relayedMessages", nonce]),
          ),
          4n,
        ],
      ),
    );

    const payload = {
      id: 1,
      jsonrpc: "2.0",
      method: "tenderly_setStorageAt",
      params: [
        foreignBridgeAddress,
        storageSlot,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    };

    await axios.post(process.env.TENDERLY_ETHEREUM_ADMIN_RPC, payload);
    console.log("Storage overridden successfully");
  }
}

// Poll for ERC20 balance change on target chain
export async function waitForBalanceChange(
  client,
  walletAddress,
  tokenAddress,
  initialBalance,
  timeout = 300000,
) {
  console.log(
    `Waiting for balance change of ${tokenAddress} for ${walletAddress}...`,
  );
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const currentBalance = await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress],
    });

    if (currentBalance > initialBalance) {
      console.log(`Balance changed: ${initialBalance} -> ${currentBalance}`);
      return currentBalance;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error(`Timeout waiting for balance change after ${timeout}ms`);
}

// Poll for native balance change on target chain
export async function waitForNativeBalanceChange(
  client,
  walletAddress,
  initialBalance,
  timeout = 300000,
) {
  console.log(`Waiting for native balance change for ${walletAddress}...`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const currentBalance = await client.getBalance({ address: walletAddress });

    if (currentBalance > initialBalance) {
      console.log(
        `Native balance changed: ${initialBalance} -> ${currentBalance}`,
      );
      return currentBalance;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error(
    `Timeout waiting for native balance change after ${timeout}ms`,
  );
}

// Wait for AddedReceiver event from the Block Reward contract on GC
export async function waitForAddedReceiverEvent(
  client,
  blockRewardAddress,
  receiver,
  bridgeAddress,
  fromBlock,
  timeout = 300000,
) {
  console.log(`Waiting for AddedReceiver event on Block Reward contract...`);
  console.log(`  receiver: ${receiver}, bridge: ${bridgeAddress}`);
  const startTime = Date.now();

  const eventAbi = [
    parseAbiItem(
      "event AddedReceiver(uint256 amount, address indexed receiver, address indexed bridge)",
    ),
  ];

  while (Date.now() - startTime < timeout) {
    const logs = await client.getLogs({
      address: blockRewardAddress,
      event: eventAbi[0],
      args: {
        receiver,
        bridge: bridgeAddress,
      },
      fromBlock,
      toBlock: "latest",
    });

    if (logs.length > 0) {
      const { amount, receiver: recv, bridge } = logs[0].args;
      console.log(
        `AddedReceiver event found: amount=${amount}, receiver=${recv}, bridge=${bridge}`,
      );
      return logs[0];
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error(`Timeout waiting for AddedReceiver event after ${timeout}ms`);
}

// Get ERC20 balance
export async function getErc20Balance(client, tokenAddress, walletAddress) {
  return client.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress],
  });
}

// Assert helper
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  PASS: ${message}`);
}

export async function getUserRequestForSignatureEventAndGetSignatures(
  gnoClient,
  txReceipt,
) {
  // fetch the event

  // const UserRequestForSignatureEvent =
  //   "0xbcb4ebd89690a7455d6ec096a6bfc4a8a891ac741ffe4e678ea2614853248658"; //  UserRequestForSignature event signature before USDS upgrade
  const UserRequestForSignatureEvent =
    "0xe1e0bc4a1db39a361e3589cae613d7b4862e1f9114dd3ff12ff45be395046968";
  const xDAIBridgeHelper = "0xe30269bc61E677cD60aD163a221e464B7022fbf5";

  const relevantLog = txReceipt.logs.find(
    (log) => log.topics[0] === UserRequestForSignatureEvent,
  );
  if (relevantLog) {
    console.log("Found UserRequestForSignature event");

    // Decode the log data
    // The data contains: recipient (address), value (uint256), nonce (bytes32), token (address)
    const decodedData = {
      recipient: `0x${relevantLog.data.slice(26, 66)}`,
      value: BigInt(`0x${relevantLog.data.slice(66, 130)}`),
      nonce: `0x${relevantLog.data.slice(130, 194)}`,
      token: `0x${relevantLog.data.slice(218, 258)}`,
    };

    // call xdai bridge helper

    const msgHash = await gnoClient.readContract({
      address: xDAIBridgeHelper,
      abi: [
        parseAbiItem(
          "function getMessageHash(address _recipient, uint256 _value, bytes32 _origTxHash, address _token) returns (bytes32)",
        ),
      ],
      functionName: "getMessageHash",
      args: [
        decodedData.recipient,
        decodedData.value,
        decodedData.nonce,
        decodedData.token,
      ],
    });
    console.log("Message Hash ", msgHash);
    const message = await gnoClient.readContract({
      address: xDAIBridgeHelper,
      abi: [
        parseAbiItem("function getMessage(bytes32 _msgHash) returns (bytes)"),
      ],
      functionName: "getMessage",
      args: [msgHash],
    });

    console.log("Message ", message);
    const signatures = await gnoClient.readContract({
      address: xDAIBridgeHelper,
      abi: [
        parseAbiItem(
          "function getSignatures(bytes32 _msgHash) returns (bytes)",
        ),
      ],
      functionName: "getSignatures",
      args: [msgHash],
    });

    console.log("signatures ", signatures);
    return { message, signatures };
  } else {
    console.log("No UserRequestForSignature event found");
  }
}
