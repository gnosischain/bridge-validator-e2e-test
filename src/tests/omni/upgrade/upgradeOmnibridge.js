// Upgrade both Omnibridge mediators to the new implementations, on the Tenderly forks.
//
//   Foreign (Ethereum) proxy 0x88ad…5671 -> 0x00e7097e9c1ce7121fc466ff31a7c742d5a26ea2
//   Home    (Gnosis)   proxy 0xf6A7…268d -> 0x992685a4117a5c217f3a0e33f735565ad132b12a
//
// Both proxies are EternalStorageProxy: `upgradeTo(uint256 version, address impl)` gated on
// upgradeabilityOwner(). On mainnet/GC that owner is a multisig, so the call is sent as an
// impersonated tx through the Tenderly Admin RPCå.
//
// Storage lives in the proxy, so an upgrade must not disturb it: the script snapshots a set of
// mediator getters before the upgrade and re-reads them after, failing if any moved.
//
//   node src/tests/omni/upgrade/upgradeOmnibridge.js
//
// Overridable via env: NEW_FOREIGN_OMNIBRIDGE_IMPL, NEW_HOME_OMNIBRIDGE_IMPL.
import axios from "axios";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  numberToHex,
  parseAbiItem,
  getAddress,
} from "viem";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

import { ETHEREUM, GNOSIS } from "../../../utils/constant.js";
import {
  virtual_mainnet,
  virtual_gnosis,
  validateRpcUrls,
} from "../../../utils/viemClientAndNetwork.js";
import { assert } from "../../../utils/validator.js";

validateRpcUrls();

const NEW_FOREIGN_IMPL = getAddress(
  process.env.NEW_FOREIGN_OMNIBRIDGE_IMPL ||
    "0x00e7097e9c1ce7121fc466ff31a7c742d5a26ea2",
);
const NEW_HOME_IMPL = getAddress(
  process.env.NEW_HOME_OMNIBRIDGE_IMPL ||
    "0x992685a4117a5c217f3a0e33f735565ad132b12a",
);

const proxyAbi = [
  parseAbiItem("function version() view returns (uint256)"),
  parseAbiItem("function implementation() view returns (address)"),
  parseAbiItem("function upgradeabilityOwner() view returns (address)"),
  parseAbiItem("function upgradeTo(uint256 version, address implementation)"),
];

// Mediator getters that must survive the implementation swap untouched — they all read from
// the proxy's eternal storage.
const mediatorAbi = [
  parseAbiItem("function bridgeContract() view returns (address)"),
  parseAbiItem("function mediatorContractOnOtherSide() view returns (address)"),
  parseAbiItem("function owner() view returns (address)"),
  parseAbiItem("function dailyLimit(address) view returns (uint256)"),
  parseAbiItem("function maxPerTx(address) view returns (uint256)"),
  parseAbiItem("function minPerTx(address) view returns (uint256)"),
  parseAbiItem("function executionDailyLimit(address) view returns (uint256)"),
  parseAbiItem("function executionMaxPerTx(address) view returns (uint256)"),
];

async function adminRpc(url, method, params = []) {
  const { data } = await axios.post(url, {
    id: 1,
    jsonrpc: "2.0",
    method,
    params,
  });
  if (data.error) {
    throw new Error(`RPC error (${method}): ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

async function readStorageSnapshot(client, proxy, token) {
  const snapshot = {};
  for (const fn of [
    "bridgeContract",
    "mediatorContractOnOtherSide",
    "owner",
    "dailyLimit",
    "maxPerTx",
    "minPerTx",
    "executionDailyLimit",
    "executionMaxPerTx",
  ]) {
    const takesToken = ![
      "bridgeContract",
      "mediatorContractOnOtherSide",
      "owner",
    ].includes(fn);
    try {
      const value = await client.readContract({
        address: proxy,
        abi: mediatorAbi,
        functionName: fn,
        args: takesToken ? [token] : [],
      });
      snapshot[fn] = String(value);
    } catch {
      // A getter the implementation does not expose is not a regression by itself; record the
      // absence so the before/after comparison still catches a *change*.
      snapshot[fn] = "<unavailable>";
    }
  }
  return snapshot;
}

async function upgradeImpl({
  label,
  client,
  adminRpcUrl,
  proxy,
  newImpl,
  token,
}) {
  console.log(`\n=== ${label} Omnibridge ===`);
  console.log(`  proxy:    ${proxy}`);

  const [versionBefore, implBefore, upgradeOwner] = await Promise.all([
    client.readContract({
      address: proxy,
      abi: proxyAbi,
      functionName: "version",
    }),
    client.readContract({
      address: proxy,
      abi: proxyAbi,
      functionName: "implementation",
    }),
    client.readContract({
      address: proxy,
      abi: proxyAbi,
      functionName: "upgradeabilityOwner",
    }),
  ]);
  console.log(`  version:  ${versionBefore}`);
  console.log(`  impl:     ${implBefore}`);
  console.log(`  upgradeabilityOwner: ${upgradeOwner}`);
  console.log(`  target impl: ${newImpl}`);

  const newImplCode = await client.getCode({ address: newImpl });
  assert(
    Boolean(newImplCode) && newImplCode !== "0x",
    `${label}: new implementation ${newImpl} has code on the fork`,
  );

  if (getAddress(implBefore) === newImpl) {
    console.log(`  Already at the new implementation — nothing to do.`);
    return {
      skipped: true,
      version: versionBefore,
      implementation: implBefore,
    };
  }

  const storageBefore = await readStorageSnapshot(client, proxy, token);

  const nextVersion = versionBefore + 1n;
  const data = encodeFunctionData({
    abi: proxyAbi,
    functionName: "upgradeTo",
    args: [nextVersion, newImpl],
  });

  console.log(
    `\n  upgradeTo(${nextVersion}, ${newImpl}) as ${upgradeOwner}...`,
  );
  // Pass an explicit gas limit. Left unset, Tenderly bills the impersonated tx at the block gas
  // limit, which on the Gnosis VNet gets mined as a revert (~29k gas used) instead of executing.
  const txHash = await adminRpc(adminRpcUrl, "eth_sendTransaction", [
    {
      from: upgradeOwner,
      to: proxy,
      value: "0x0",
      data,
      gas: numberToHex(1000000),
    },
  ]);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  console.log(`  tx: ${txHash}`);
  assert(
    receipt.status === "success",
    `${label}: upgradeTo transaction succeeded`,
  );
  assert(
    receipt.logs.length > 0,
    `${label}: upgrade emitted event(s) (Upgraded)`,
  );

  const [versionAfter, implAfter] = await Promise.all([
    client.readContract({
      address: proxy,
      abi: proxyAbi,
      functionName: "version",
    }),
    client.readContract({
      address: proxy,
      abi: proxyAbi,
      functionName: "implementation",
    }),
  ]);
  assert(
    getAddress(implAfter) === newImpl,
    `${label}: implementation is now ${newImpl} (was ${implBefore})`,
  );
  assert(
    versionAfter === nextVersion,
    `${label}: version bumped ${versionBefore} -> ${versionAfter}`,
  );

  const storageAfter = await readStorageSnapshot(client, proxy, token);
  for (const [key, before] of Object.entries(storageBefore)) {
    assert(
      storageAfter[key] === before,
      `${label}: ${key} preserved across the upgrade (${before})`,
    );
  }

  return { skipped: false, version: versionAfter, implementation: implAfter };
}

async function main() {
  console.log("=== Omnibridge implementation upgrade (Foreign + Home) ===");

  const ethClient = createPublicClient({
    chain: virtual_mainnet,
    transport: http(),
  });
  const gnoClient = createPublicClient({
    chain: virtual_gnosis,
    transport: http(),
  });

  const foreign = await upgradeImpl({
    label: "Foreign (Ethereum)",
    client: ethClient,
    adminRpcUrl: process.env.TENDERLY_ETHEREUM_ADMIN_RPC,
    proxy: getAddress(ETHEREUM.OMNIBRIDGE),
    newImpl: NEW_FOREIGN_IMPL,
    token: getAddress(ETHEREUM.WETH),
  });

  const home = await upgradeImpl({
    label: "Home (Gnosis Chain)",
    client: gnoClient,
    adminRpcUrl: process.env.TENDERLY_GNOSIS_ADMIN_RPC,
    proxy: getAddress(GNOSIS.OMNIBRIDGE),
    newImpl: NEW_HOME_IMPL,
    token: getAddress(GNOSIS.WETH),
  });

  console.log("\n=== Upgrade summary ===");
  console.log(
    `  Foreign (ETH): version ${foreign.version}, impl ${foreign.implementation}${foreign.skipped ? " (already upgraded)" : ""}`,
  );
  console.log(
    `  Home    (GC):  version ${home.version}, impl ${home.implementation}${home.skipped ? " (already upgraded)" : ""}`,
  );
  console.log("\n=== UPGRADE PASSED ===");
}

main().catch((err) => {
  console.error("\n=== UPGRADE FAILED ===", err);
  process.exitCode = 1;
});
