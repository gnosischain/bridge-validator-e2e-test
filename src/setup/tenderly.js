// Tenderly Virtual TestNet bookkeeping shared by setup.js (create) and
// teardown.js (delete). Every VNet setup.js creates is appended to
// .tenderly-vnets.json the moment it exists, so teardown can delete it even if
// the rest of the run fails.

import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");

export const VNETS_FILE = path.join(ROOT_DIR, ".tenderly-vnets.json");

// CI VNets get their own prefix so the scheduled sweep (teardown.js --sweep)
// can never touch a VNet someone created locally with `npm run setup`.
export const CI_SLUG_PREFIX = "e2e-ci-";

export function slugPrefix() {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return "e2e-";
  return `${CI_SLUG_PREFIX}${runId}-${process.env.GITHUB_RUN_ATTEMPT || 1}-`;
}

// Fork block per chain. Defaults to the latest block; pin with
// TENDERLY_FORK_BLOCK_ETH / TENDERLY_FORK_BLOCK_GC for reproducible runs.
export function forkBlock(networkId) {
  const pinned =
    networkId === 1
      ? process.env.TENDERLY_FORK_BLOCK_ETH
      : process.env.TENDERLY_FORK_BLOCK_GC;
  return pinned || "latest";
}

export function readVnets() {
  try {
    return JSON.parse(fs.readFileSync(VNETS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function writeVnets(vnets) {
  if (vnets.length === 0) {
    fs.rmSync(VNETS_FILE, { force: true });
  } else {
    fs.writeFileSync(VNETS_FILE, `${JSON.stringify(vnets, null, 2)}\n`);
  }
}

export function recordVnet(vnet) {
  if (!vnet.id) {
    console.warn(`  WARNING: Tenderly returned no id for ${vnet.slug}; teardown cannot delete it.`);
    return;
  }
  writeVnets([...readVnets(), { ...vnet, createdAt: new Date().toISOString() }]);
}

function api() {
  const { TENDERLY_API_TOKEN, TENDERLY_ACCOUNT_ID, TENDERLY_PROJECT } = process.env;
  const missing = ["TENDERLY_API_TOKEN", "TENDERLY_ACCOUNT_ID", "TENDERLY_PROJECT"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
  return axios.create({
    baseURL: `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT_ID}/project/${TENDERLY_PROJECT}`,
    headers: { "Content-Type": "application/json", "X-Access-Key": TENDERLY_API_TOKEN },
    timeout: 30000,
  });
}

// Resolves true when deleted (or already gone), false on any other failure.
export async function deleteVnet(id) {
  try {
    await api().delete(`/vnets/${id}`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) return true;
    const detail = err.response ? `HTTP ${err.response.status}` : err.message;
    console.error(`  Failed to delete VNet ${id}: ${detail}`);
    return false;
  }
}

export async function listVnets({ perPage = 100, maxPages = 20 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await api().get("/vnets", { params: { page, per_page: perPage } });
    const items = Array.isArray(data) ? data : data?.vnets || data?.virtual_networks || [];
    all.push(...items);
    if (items.length < perPage) break;
  }
  return all;
}
