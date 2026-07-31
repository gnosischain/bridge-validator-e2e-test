import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PORT, TICK_SECONDS } from "./config.js";
import { indexChain } from "./indexer.js";
import { reconcileAll } from "./reconcile.js";
import { buildSnapshot } from "./snapshot.js";
import { redis } from "./store.js";

const uiPath = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");

const log = (...args) => console.log(new Date().toISOString(), ...args);

let lastTick = { at: null, ok: false, error: null };

async function tick() {
  const started = Date.now();
  try {
    // Index both chains before reconciling so a source event and the receipt
    // that answers it can settle in the same pass.
    for (const chain of ["eth", "gc"]) {
      const r = await indexChain(chain);
      log(`indexed ${chain} -> head=${r.head} new sources=${r.sources ?? 0} receipts=${r.receipts ?? 0}`);
    }
    for (const r of await reconcileAll()) {
      if (r.checked) {
        log(
          `reconciled ${r.validator} checked=${r.checked} ontime=${r.ontime} delayed=${r.delayed} missed=${r.missed}`,
        );
      }
    }
    lastTick = { at: Math.floor(Date.now() / 1000), ok: true, error: null, ms: Date.now() - started };
  } catch (err) {
    log("tick failed:", err.message);
    lastTick = { at: Math.floor(Date.now() / 1000), ok: false, error: err.message };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/metrics") {
      const snapshot = await buildSnapshot();
      const body = JSON.stringify({ ...snapshot, lastTick }, null, 2);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(body);
    }
    if (path === "/healthz") {
      res.writeHead(lastTick.ok || lastTick.at === null ? 200 : 503, { "content-type": "application/json" });
      return res.end(JSON.stringify(lastTick));
    }
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(uiPath));
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(err.message);
  }
});

server.listen(PORT, () => log(`ui + api on :${PORT}`));

await tick();
setInterval(tick, TICK_SECONDS * 1000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await redis.quit();
    process.exit(0);
  });
}
