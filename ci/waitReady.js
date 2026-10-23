// Block until the stack started by ci/run.sh is usable, or exit 1.
//
//   node ci/waitReady.js [--mock]
//
// --mock  also wait for the EL mock proxies (:8545 ETH, :8546 GC) to answer.
//
// The oracle is ready once each stack's watchers have finished a polling loop,
// i.e. written their `<watcher id>:lastProcessedBlock` key to Redis. On a cold
// start they begin at the current head, so that happens within one poll.

import Redis from "ioredis";

const TIMEOUT_MS = Number(process.env.READY_TIMEOUT_SECS || 300) * 1000;
// signature-request (home) + affirmation-request (foreign) per stack
const MIN_WATCHERS = Number(process.env.READY_MIN_WATCHERS || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + TIMEOUT_MS;

async function waitFor(label, check) {
  let last = "";
  while (Date.now() < deadline) {
    try {
      const status = await check();
      if (status === true) {
        console.log(`  ready: ${label}`);
        return;
      }
      last = status || "";
    } catch (err) {
      last = err.message;
    }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ` (last: ${last})` : ""}`);
}

async function blockNumber(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return parseInt(body.result, 16);
}

async function main() {
  console.log(`Waiting for the stack (timeout ${TIMEOUT_MS / 1000}s)...`);

  if (process.argv.includes("--mock")) {
    const eth = process.env.MOCK_ETH_URL || "http://localhost:8545";
    const gc = process.env.MOCK_GC_URL || "http://localhost:8546";
    for (const [label, url] of [["mock ETH", eth], ["mock GC", gc]]) {
      await waitFor(`${label} (${url})`, async () => (await blockNumber(url)) > 0);
    }
  }

  const stores = [
    ["oracle amb", process.env.REDIS_URL_AMB || "redis://localhost:6379"],
    ["oracle xdai", process.env.REDIS_URL_XDAI || "redis://localhost:6378"],
  ];
  for (const [label, url] of stores) {
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on("error", () => {});
    try {
      await waitFor(`${label} watchers`, async () => {
        if (redis.status !== "ready") await redis.connect().catch(() => {});
        const keys = await redis.keys("*:lastProcessedBlock");
        return keys.length >= MIN_WATCHERS || `${keys.length}/${MIN_WATCHERS} watchers reported`;
      });
    } finally {
      redis.disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
