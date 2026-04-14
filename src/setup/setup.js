import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ETHEREUM, GNOSIS } from "../utils/constant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");

const TENDERLY_API_TOKEN = process.env.TENDERLY_API_TOKEN;
const TENDERLY_ACCOUNT_ID = process.env.TENDERLY_ACCOUNT_ID;
const TENDERLY_PROJECT = process.env.TENDERLY_PROJECT;

// Contract owners on mainnet (impersonated via Tenderly Admin RPC)
const ETH_BRIDGE_OWNER = "0x42F38ec5A75acCEc50054671233dfAC9C0E7A3F6";
const GC_BRIDGE_OWNER = "0x7a48Dac683DA91e4faa5aB13D91AB5fd170875bd";

// New implementation addresses for bridge upgrades
const PROXY_ADMIN = "0xD7e65A32bEd4ce8cc57Ec188F2bBb8016dc4b1cd";

// ─── Helper: JSON-RPC call ──────────────────────────────────────────────
async function rpc(url, method, params = []) {
  const { data } = await axios.post(url, {
    id: 1,
    jsonrpc: "2.0",
    method,
    params,
  });
  if (data.error)
    throw new Error(`RPC error (${method}): ${JSON.stringify(data.error)}`);
  return data.result;
}

// Helper: Send impersonated transaction via Admin RPC
async function sendAdminTx(adminRpc, from, to, data, value = "0x0") {
  return rpc(adminRpc, "eth_sendTransaction", [{ from, to, value, data }]);
}

// ─── Step 1: Generate accounts ──────────────────────────────────────────
function generateAccounts() {
  console.log("Generating accounts...");

  const userPrivateKey = generatePrivateKey();
  const userAccount = privateKeyToAccount(userPrivateKey);

  const validatorPrivateKey = generatePrivateKey();
  const validatorAccount = privateKeyToAccount(validatorPrivateKey);

  console.log(`  Alice:     ${userAccount.address}`);
  console.log(`  Alice Private Key: ${userPrivateKey}`);
  console.log(`  Validator: ${validatorAccount.address}`);
  console.log(`  Validator Private Key: ${validatorPrivateKey}`);

  return {
    userPrivateKey,
    userAddress: userAccount.address,
    validatorPrivateKey,
    validatorAddress: validatorAccount.address,
  };
}

// ─── Step 2: Create Tenderly Virtual TestNets ───────────────────────────
async function createVirtualTestNet(networkId, displayName) {
  console.log(
    `\nCreating Virtual TestNet: ${displayName} (network ${networkId})...`,
  );

  const apiUrl = `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT_ID}/project/${TENDERLY_PROJECT}/vnets`;
  const slug = `e2e-${displayName.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;

  const { data } = await axios.post(
    apiUrl,
    {
      slug,
      display_name: displayName,
      fork_config: {
        network_id: networkId,
        block_number: "latest",
      },
      virtual_network_config: {
        chain_config: {
          chain_id: networkId,
        },
      },
      sync_state_config: {
        enabled: true,
        commitment_level: "latest",
      },
      explorer_page_config: {
        enabled: true,
        verification_visibility: "bytecode",
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Access-Key": TENDERLY_API_TOKEN,
      },
    },
  );

  const adminRpc = data.rpcs.find((r) => r.name === "Admin RPC")?.url;
  const publicRpc = data.rpcs.find((r) => r.name === "Public RPC")?.url;
  const explorerUrl = data.explorer_page?.url || "";

  console.log(`  Admin RPC:  ${adminRpc}`);
  console.log(`  Public RPC: ${publicRpc}`);
  console.log(`  Explorer:   ${explorerUrl}`);

  return { adminRpc, publicRpc, explorerUrl };
}

// ─── Step 3: Fund accounts ──────────────────────────────────────────────
async function fundAccounts(
  ethAdminRpc,
  gnoAdminRpc,
  userAddress,
  validatorAddress,
) {
  console.log("\nFunding accounts...");

  const eth100 = toHex(parseEther("100"));
  const eth1 = toHex(parseEther("1"));
  const erc20_100 = toHex(parseEther("100"));

  // Validator: 1 ETH + 1 xDAI
  console.log("  Funding bridge validator...");
  await rpc(ethAdminRpc, "tenderly_setBalance", [[validatorAddress], eth1]);
  await rpc(gnoAdminRpc, "tenderly_setBalance", [[validatorAddress], eth1]);

  // Alice: 100 ETH
  console.log("  Funding alice with 100 ETH...");
  await rpc(ethAdminRpc, "tenderly_setBalance", [[userAddress], eth100]);

  // Alice: 100 DAI, 100 USDS, 100 GNO on Ethereum
  console.log("  Funding alice with ERC20 tokens on Ethereum...");
  await rpc(ethAdminRpc, "tenderly_setErc20Balance", [
    ETHEREUM.DAI,
    userAddress,
    erc20_100,
  ]);
  await rpc(ethAdminRpc, "tenderly_setErc20Balance", [
    ETHEREUM.USDS,
    userAddress,
    erc20_100,
  ]);
  await rpc(ethAdminRpc, "tenderly_setErc20Balance", [
    ETHEREUM.GNO,
    userAddress,
    erc20_100,
  ]);

  // Alice: 100 xDAI
  console.log("  Funding alice with 100 xDAI...");
  await rpc(gnoAdminRpc, "tenderly_setBalance", [[userAddress], eth100]);

  // Alice: 100 WETH, 100 GNO on GC
  console.log("  Funding alice with ERC20 tokens on Gnosis Chain...");
  await rpc(gnoAdminRpc, "tenderly_setErc20Balance", [
    GNOSIS.WETH,
    userAddress,
    erc20_100,
  ]);
  await rpc(gnoAdminRpc, "tenderly_setErc20Balance", [
    GNOSIS.GNO,
    userAddress,
    erc20_100,
  ]);

  console.log("  Accounts funded.");
}

// ─── Step 4: Register bridge validators ─────────────────────────────────
async function registerValidators(ethAdminRpc, gnoAdminRpc, validatorAddress) {
  console.log("\nRegistering bridge validators...");

  const addValidatorData = `0x4d238c8e000000000000000000000000${validatorAddress.slice(2).toLowerCase()}`;
  const setRequiredSig1 =
    "0x7d2b9cc00000000000000000000000000000000000000000000000000000000000000001";

  // ETH: xDAI validator management
  console.log(
    "  [ETH] xDAI validators: addValidator + setRequiredSignatures(1)...",
  );
  await sendAdminTx(
    ethAdminRpc,
    ETH_BRIDGE_OWNER,
    ETHEREUM.XDAI_VALIDATOR_MANAGEMENT,
    addValidatorData,
  );
  await sendAdminTx(
    ethAdminRpc,
    ETH_BRIDGE_OWNER,
    ETHEREUM.XDAI_VALIDATOR_MANAGEMENT,
    setRequiredSig1,
  );

  // ETH: AMB validator management
  console.log(
    "  [ETH] AMB validators: addValidator + setRequiredSignatures(1)...",
  );
  await sendAdminTx(
    ethAdminRpc,
    ETH_BRIDGE_OWNER,
    ETHEREUM.AMB_VALIDATOR_MANAGEMENT,
    addValidatorData,
  );
  await sendAdminTx(
    ethAdminRpc,
    ETH_BRIDGE_OWNER,
    ETHEREUM.AMB_VALIDATOR_MANAGEMENT,
    setRequiredSig1,
  );

  // GC: xDAI validator management
  console.log(
    "  [GC] xDAI validators: addValidator + setRequiredSignatures(1)...",
  );
  await sendAdminTx(
    gnoAdminRpc,
    GC_BRIDGE_OWNER,
    GNOSIS.XDAI_VALIDATOR_MANAGEMENT,
    addValidatorData,
  );
  await sendAdminTx(
    gnoAdminRpc,
    GC_BRIDGE_OWNER,
    GNOSIS.XDAI_VALIDATOR_MANAGEMENT,
    setRequiredSig1,
  );

  // GC: AMB validator management
  console.log(
    "  [GC] AMB validators: addValidator + setRequiredSignatures(1)...",
  );
  await sendAdminTx(
    gnoAdminRpc,
    GC_BRIDGE_OWNER,
    GNOSIS.AMB_VALIDATOR_MANAGEMENT,
    addValidatorData,
  );
  await sendAdminTx(
    gnoAdminRpc,
    GC_BRIDGE_OWNER,
    GNOSIS.AMB_VALIDATOR_MANAGEMENT,
    setRequiredSig1,
  );

  console.log("  Validators registered.");
}

// ─── Step 6: Write .env.testnet ─────────────────────────────────────────
function writeEnvTestnet(ethVn, gnoVn, accounts) {
  const content = `# Auto-generated by setup.js — do not edit manually
TENDERLY_ETHEREUM_RPC=${ethVn.publicRpc}
TENDERLY_ETHEREUM_ADMIN_RPC=${ethVn.adminRpc}
TENDERLY_GNOSIS_RPC=${gnoVn.publicRpc}
TENDERLY_GNOSIS_ADMIN_RPC=${gnoVn.adminRpc}
TENDERLY_ETHEREUM_EXPLORER=${ethVn.explorerUrl}
TENDERLY_GNOSIS_EXPLORER=${gnoVn.explorerUrl}
USER_PRIVATE_KEY=${accounts.userPrivateKey}
VALIDATOR_PRIVATE_KEY=${accounts.validatorPrivateKey}
`;
  const envPath = path.join(ROOT_DIR, ".env.testnet");
  fs.writeFileSync(envPath, content);
  console.log(`\nWrote configuration to ${envPath}`);
}

// ─── Step 7: Write .env.bridge.validator for docker-compose-rust.yml ────────────────
function writeEnvRust(ethVn, gnoVn, accounts, { autoclaim = false } = {}) {
  const dockersDir = path.join(__dirname, "docker");
  const examplePath = path.join(dockersDir, ".env.bridge.validator.example");
  const envPath = path.join(dockersDir, ".env.bridge.validator");

  fs.copyFileSync(examplePath, envPath);

  const replacements = {
    GC_RPC: gnoVn.publicRpc,
    ETH_RPC: ethVn.publicRpc,
    AMB_VALIDATOR_PRIV_KEY: accounts.validatorPrivateKey,
    XDAI_VALIDATOR_PRIV_KEY: accounts.validatorPrivateKey,
    XDAI_EXECUTE_MESSAGE_ON_FOREIGN: autoclaim,
    AMB_EXECUTE_MESSAGE_ON_FOREIGN: autoclaim,
  };

  let content = fs.readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replace(
      new RegExp(`^${key}=.*$`, "m"),
      `${key}=${value}`,
    );
  }
  fs.writeFileSync(envPath, content);

  console.log(`Wrote configuration to ${envPath}`);
  if (autoclaim) {
    console.log(
      "  Auto-claim enabled: validator will execute messages on foreign chain",
    );
  }
}

// ─── Step 8: Update .env.oracle.xdai and .env.oracle.amb ───────────────
function updateOracleEnvFiles(ethVn, gnoVn, accounts) {
  const dockersDir = path.join(__dirname, "docker");
  const files = [".env.oracle.xdai", ".env.oracle.amb"];

  const replacements = {
    ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY: accounts.validatorPrivateKey,
    ORACLE_VALIDATOR_ADDRESS: accounts.validatorAddress,
    COMMON_HOME_RPC_URL: gnoVn.publicRpc,
    COMMON_FOREIGN_RPC_URL: ethVn.publicRpc,
  };

  for (const file of files) {
    const examplePath = path.join(dockersDir, `${file}.example`);
    const filePath = path.join(dockersDir, file);

    fs.copyFileSync(examplePath, filePath);

    let content = fs.readFileSync(filePath, "utf8");

    for (const [key, value] of Object.entries(replacements)) {
      content = content.replace(
        new RegExp(`^${key}=.*$`, "m"),
        `${key}=${value}`,
      );
    }

    fs.writeFileSync(filePath, content);
    console.log(`Updated ${filePath}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const autoclaim = process.argv.includes("--autoclaim");
  console.log("=== Bridges E2E Test Setup ===\n");

  const required = [
    "TENDERLY_API_TOKEN",
    "TENDERLY_ACCOUNT_ID",
    "TENDERLY_PROJECT",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  // 1. Generate accounts
  const accounts = generateAccounts();

  // 2. Create Virtual TestNets
  const ethVn = await createVirtualTestNet(1, "E2E Ethereum Mainnet");
  const gnoVn = await createVirtualTestNet(100, "E2E Gnosis Chain");

  // 3. Write .env.testnet, .env.bridge.validator, and update oracle env files
  writeEnvTestnet(ethVn, gnoVn, accounts);
  writeEnvRust(ethVn, gnoVn, accounts, { autoclaim });
  updateOracleEnvFiles(ethVn, gnoVn, accounts);

  // 4. Fund accounts
  await fundAccounts(
    ethVn.adminRpc,
    gnoVn.adminRpc,
    accounts.userAddress,
    accounts.validatorAddress,
  );

  // 5. Register validators
  await registerValidators(
    ethVn.adminRpc,
    gnoVn.adminRpc,
    accounts.validatorAddress,
  );

  console.log("\n=== Setup complete! ===");
  console.log("Next steps:");
  console.log("  1. Start either of bridge validator docker containers:");
  console.log(
    "     docker compose -f src/setup/docker/docker-compose-xdai.yml up -d",
  );
  console.log(
    "    docker compose -f src/setup/docker/docker-compose-amb.yml up -d",
  );
  console.log(
    "     docker compose -f src/setup/docker/docker-compose-rust.yml up -d",
  );

  console.log("  2. Run tests: npm test");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exitCode = 1;
});
