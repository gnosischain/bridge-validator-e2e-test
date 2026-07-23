// Boot the two EL proxy mocks — see FCR_integration.md.
//
//   :8545  → Ethereum upstream (TENDERLY_ETHEREUM_RPC)   [oracle "foreign"]
//   :8546  → Gnosis   upstream (TENDERLY_GNOSIS_RPC)      [oracle "home"]
//
// Each instance has independent state. The real Tenderly URLs stay in
// .env.testnet; setup.js repoints the oracle/rust EL RPC vars at these mocks.
//
//   npm run mock

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createMock } from "./elRpcServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");

// Prefer .env.testnet (written by setup.js); fall back to .env.
dotenv.config({ path: path.join(ROOT_DIR, ".env.testnet") });
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const ETH_UPSTREAM = process.env.TENDERLY_ETHEREUM_RPC;
const GC_UPSTREAM = process.env.TENDERLY_GNOSIS_RPC;

const ETH_PORT = Number(process.env.MOCK_ETH_PORT || 8545);
const GC_PORT = Number(process.env.MOCK_GC_PORT || 8546);

if (!ETH_UPSTREAM || !GC_UPSTREAM) {
  console.error(
    "Missing TENDERLY_ETHEREUM_RPC / TENDERLY_GNOSIS_RPC — run `npm run setup` first.",
  );
  process.exit(1);
}

const eth = createMock(ETH_UPSTREAM, ETH_PORT, { label: "ETH" });
const gc = createMock(GC_UPSTREAM, GC_PORT, { label: "GC" });

console.log("\nEL proxy mocks up. Control plane:");
console.log(`  ETH  POST http://localhost:${ETH_PORT}/admin   GET /admin/state`);
console.log(`  GC   POST http://localhost:${GC_PORT}/admin   GET /admin/state`);
console.log("Ctrl-C to stop.\n");

function shutdown() {
  console.log("\nShutting down mocks…");
  eth.server.close();
  gc.server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
