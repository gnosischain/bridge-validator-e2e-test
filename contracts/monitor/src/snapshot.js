import { BRIDGES, CHAINS, GRACE_S, MAX_DELAY_S, TICK_SECONDS, VALIDATORS } from "./config.js";
import { K, getHead, redis } from "./store.js";

const n = (hash, field) => Number(hash?.[field] ?? 0);
const perBridge = (hash, prefix) =>
  Object.fromEntries(BRIDGES.map((b) => [b, n(hash, `${prefix}:${b}`)]));

/// Everything the UI renders, assembled from the counters the reconciler owns.
export async function buildSnapshot() {
  const [global, heads] = await Promise.all([
    redis.hgetall(K.metricsGlobal),
    Promise.all([getHead("eth"), getHead("gc")]),
  ]);

  const validators = await Promise.all(
    VALIDATORS.map(async (v) => {
      const [metrics, pending, delayedRaw, missedRaw] = await Promise.all([
        redis.hgetall(K.metrics(v.name)),
        redis.zcard(K.pending(v.name)),
        redis.lrange(K.delayed(v.name), 0, 49),
        redis.lrange(K.missed(v.name), 0, 49),
      ]);

      const bucket = (prefix) => ({
        eth: n(metrics, `${prefix}:eth`),
        gc: n(metrics, `${prefix}:gc`),
        byBridge: { eth: perBridge(metrics, `${prefix}:eth`), gc: perBridge(metrics, `${prefix}:gc`) },
      });

      const signed = bucket("signed");
      const ontime = bucket("ontime");
      const delayed = bucket("delayed");

      return {
        name: v.name,
        address: v.address,
        pending,
        signed,
        ontime,
        delayed,
        missed: bucket("missed"),
        // Receipts from contract K with no matching source event — normally
        // events that predate the indexer's start block.
        unmatched: {
          eth: Math.max(0, signed.eth - ontime.eth - delayed.eth),
          gc: Math.max(0, signed.gc - ontime.gc - delayed.gc),
        },
        delayedSamples: delayedRaw.map((r) => JSON.parse(r)),
        missedSamples: missedRaw.map((r) => JSON.parse(r)),
      };
    }),
  );

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    tickSeconds: TICK_SECONDS,
    thresholds: MAX_DELAY_S,
    graceSeconds: GRACE_S,
    heads: { eth: heads[0], gc: heads[1] },
    explorers: { eth: CHAINS.eth.explorer, gc: CHAINS.gc.explorer },
    global: {
      src: { eth: n(global, "src:eth"), gc: n(global, "src:gc") },
      byBridge: { eth: perBridge(global, "src:eth"), gc: perBridge(global, "src:gc") },
    },
    validators,
  };
}
