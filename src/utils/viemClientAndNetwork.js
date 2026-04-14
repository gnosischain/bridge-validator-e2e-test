import { createWalletClient, createPublicClient, http, publicActions, defineChain } from "viem";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.testnet" });

export const virtual_mainnet = defineChain({
  id: 1,
  name: "Tenderly Virtual Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.TENDERLY_ETHEREUM_RPC],
    },
  },
  blockExplorers: {
    default: {
      name: "Tenderly Explorer",
      url: process.env.TENDERLY_ETHEREUM_EXPLORER || "https://dashboard.tenderly.co",
    },
  },
});

export const virtual_gnosis = defineChain({
  id: 100,
  name: "Tenderly Virtual Gnosis",
  nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.TENDERLY_GNOSIS_RPC],
    },
  },
  blockExplorers: {
    default: {
      name: "Tenderly Explorer",
      url: process.env.TENDERLY_GNOSIS_EXPLORER || "https://dashboard.tenderly.co",
    },
  },
});

export function validateRpcUrls() {
  const required = [
    "TENDERLY_ETHEREUM_RPC",
    "TENDERLY_GNOSIS_RPC",
    "TENDERLY_ETHEREUM_ADMIN_RPC",
    "TENDERLY_GNOSIS_ADMIN_RPC",
    "USER_PRIVATE_KEY",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export function createEthWalletClient(account) {
  return createWalletClient({
    account,
    chain: virtual_mainnet,
    transport: http(),
  }).extend(publicActions);
}

export function createGnoWalletClient(account) {
  return createWalletClient({
    account,
    chain: virtual_gnosis,
    transport: http(),
  }).extend(publicActions);
}
