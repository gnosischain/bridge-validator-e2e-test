// Layer-B mock control-plane helpers — drive the EL proxy mock's /admin
// endpoint and the fork admin RPC (evm_increaseBlocks) from a test.
//
// A "chain" here is "eth" (oracle foreign, mock :8545) or "gc" (oracle home,
// mock :8546). Tests run on the host, so they reach the mock at localhost.

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.testnet" });

const toHex = (n) => "0x" + BigInt(n).toString(16);

// Mock admin endpoints (host side). Override via MOCK_ETH_URL / MOCK_GC_URL.
const MOCK_URL = {
  eth: process.env.MOCK_ETH_URL || "http://localhost:8545",
  gc: process.env.MOCK_GC_URL || "http://localhost:8546",
};

// Fork admin RPCs — where evm_increaseBlocks lives (bulk-mine the tip).
const ADMIN_RPC = {
  eth: process.env.TENDERLY_ETHEREUM_ADMIN_RPC,
  gc: process.env.TENDERLY_GNOSIS_ADMIN_RPC,
};

function requireChain(chain) {
  if (!MOCK_URL[chain]) throw new Error(`Unknown chain "${chain}" (use "eth" | "gc")`);
  return chain;
}

async function jsonRpc(url, method, params = []) {
  const { data } = await axios.post(url, { id: 1, jsonrpc: "2.0", method, params });
  if (data.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(data.error)}`);
  return data.result;
}

// ─── Mock /admin control plane ──────────────────────────────────────────
async function adminPatch(chain, patch) {
  requireChain(chain);
  const { data } = await axios.post(`${MOCK_URL[chain]}/admin`, patch);
  return data.state;
}

export async function getMockState(chain) {
  requireChain(chain);
  const { data } = await axios.get(`${MOCK_URL[chain]}/admin/state`);
  return data;
}

export async function resetMock(chain) {
  return adminPatch(chain, { reset: true });
}

// Freeze `finalized` at an absolute block number.
export async function pinFinalized(chain, n) {
  return adminPatch(chain, { finalized: { source: "pin", value: Number(n) } });
}

// Freeze `safe` at an absolute block number.
export async function pinSafe(chain, n) {
  return adminPatch(chain, { safe: { source: "pin", value: Number(n) } });
}

// FCR preflight modes for the `safe` tag.
export async function safeUnsupported(chain) {
  return adminPatch(chain, { safe: { source: "unsupported" } });
}
export async function safeNull(chain) {
  return adminPatch(chain, { safe: { source: "null" } });
}
export async function followSafe(chain) {
  return adminPatch(chain, { safe: { source: "follow", value: null, lag: 0 } });
}

// Return `finalized` to tracking the tip.
export async function followFinalized(chain) {
  return adminPatch(chain, { finalized: { source: "follow", value: null, lag: 0 } });
}

// Arm a reorg for a block number (used by the FCR phase).
export async function armReorg(chain, blockNumber, newHash) {
  return adminPatch(chain, { reorgs: { [Number(blockNumber)]: newHash } });
}

// ─── Chain tip / bulk advance ───────────────────────────────────────────
// Read the real tip through the mock (`latest` is proxied verbatim).
export async function getTip(chain) {
  requireChain(chain);
  return Number(BigInt(await jsonRpc(MOCK_URL[chain], "eth_blockNumber")));
}

// Bulk-mine N blocks on the fork in one deterministic call.
export async function increaseBlocks(chain, n) {
  requireChain(chain);
  if (!ADMIN_RPC[chain]) {
    throw new Error(`Missing admin RPC for "${chain}" — is .env.testnet loaded?`);
  }
  return jsonRpc(ADMIN_RPC[chain], "evm_increaseBlocks", [toHex(n)]);
}

// Push the tip forward by `blocks`, then let `finalized` follow it again so the
// pointer crosses the pinned block. Returns the new tip.
export async function advanceFinality(chain, blocks = 3) {
  await increaseBlocks(chain, blocks);
  await followFinalized(chain);
  return getTip(chain);
}
