// Delete Tenderly Virtual TestNets.
//
//   node src/setup/teardown.js
//       Delete every VNet recorded in .tenderly-vnets.json by setup.js.
//       A failed delete prints a warning but exits 0, so a Tenderly hiccup does
//       not fail an otherwise green test run; the scheduled sweep catches leftovers.
//
//   node src/setup/teardown.js --sweep [--older-than-hours 3]
//       List the project's VNets and delete CI ones (slug starts with "e2e-ci-")
//       older than the given age. Never touches VNets created outside CI.
//       Exits 1 if any delete fails.

import dotenv from "dotenv";
dotenv.config();

import {
  CI_SLUG_PREFIX,
  deleteVnet,
  listVnets,
  readVnets,
  writeVnets,
} from "./tenderly.js";

const inCi = process.env.GITHUB_ACTIONS === "true";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function deleteRecorded() {
  const vnets = readVnets();
  if (vnets.length === 0) {
    console.log("No recorded VNets to delete.");
    return;
  }
  const left = [];
  for (const vnet of vnets) {
    const ok = await deleteVnet(vnet.id);
    console.log(`  ${ok ? "deleted" : "FAILED "} ${vnet.id} (${vnet.slug})`);
    if (!ok) left.push(vnet);
  }
  writeVnets(left);
  if (left.length) {
    const msg = `${left.length} Tenderly VNet(s) could not be deleted; the scheduled sweep will retry.`;
    console.log(inCi ? `::warning::${msg}` : `WARNING: ${msg}`);
  }
}

async function sweep() {
  const hours = Number(argValue("--older-than-hours", 3));
  const cutoff = Date.now() - hours * 3600 * 1000;
  const vnets = await listVnets();
  const stale = vnets.filter((v) => {
    if (!v.slug?.startsWith(CI_SLUG_PREFIX)) return false;
    const created = Date.parse(v.created_at || v.createdAt || "");
    // No timestamp → can't prove it is stale; leave it alone.
    return Number.isFinite(created) && created < cutoff;
  });
  console.log(
    `Found ${vnets.length} VNet(s); ${stale.length} CI VNet(s) older than ${hours}h to delete.`,
  );
  let failed = 0;
  for (const v of stale) {
    const ok = await deleteVnet(v.id);
    console.log(`  ${ok ? "deleted" : "FAILED "} ${v.id} (${v.slug})`);
    if (!ok) failed++;
  }
  if (failed) {
    console.error(`${failed} delete(s) failed.`);
    process.exitCode = 1;
  }
}

(process.argv.includes("--sweep") ? sweep() : deleteRecorded()).catch((err) => {
  console.error("Teardown failed:", err.response ? `HTTP ${err.response.status}` : err.message);
  process.exitCode = 1;
});
