import { GRACE_S, K_CHAIN, MAX_DELAY_S, VALIDATORS, srcChain } from "./config.js";
import { K, getHead, pushSample, readJson, redis } from "./store.js";

// Bound the work per tick. Pending only grows if something is broken, and the
// oldest entries are the ones that need a verdict first.
const BATCH = 5000;

/// A source event stays pending until it is either answered by contract K or
/// old enough to call missed. Every counter moves exactly once, here.
export async function reconcileValidator(validator) {
  // Signatures can only land on the chain contract K lives on, so that chain's
  // head timestamp is the clock. If GC indexing stalls, nothing ages out.
  const head = await getHead(K_CHAIN);
  if (!head) return { validator, checked: 0 };

  const suffixes = await redis.zrange(K.pending(validator), 0, BATCH - 1);
  if (suffixes.length === 0) return { validator, checked: 0 };

  const [sigs, srcs] = await Promise.all([
    redis.mget(suffixes.map((s) => K.sig(validator, s))),
    redis.mget(suffixes.map((s) => K.src(s))),
  ]);

  const pipeline = redis.pipeline();
  const resolved = [];
  let ontime = 0;
  let delayed = 0;
  let missed = 0;

  suffixes.forEach((suffix, i) => {
    const src = readJson(srcs[i]);
    if (!src) {
      // Source record aged past its TTL without a verdict; stop tracking it.
      resolved.push(suffix);
      return;
    }

    const [bridge, dir] = suffix.split(":");
    const from = srcChain(dir);
    const sig = readJson(sigs[i]);

    if (sig) {
      const delay = sig.ts - src.ts;
      const onTime = delay <= MAX_DELAY_S[from];
      pipeline.hincrby(K.metrics(validator), `${onTime ? "ontime" : "delayed"}:${from}`, 1);
      pipeline.hincrby(
        K.metrics(validator),
        `${onTime ? "ontime" : "delayed"}:${from}:${bridge}`,
        1,
      );
      if (onTime) {
        ontime++;
      } else {
        delayed++;
        pushSample(pipeline, K.delayed(validator), {
          bridge,
          dir,
          id: suffix.split(":").slice(2).join(":"),
          delay,
          limit: MAX_DELAY_S[from],
          sourceTx: src.tx,
          signedTx: sig.tx,
          ts: src.ts,
        });
      }
      resolved.push(suffix);
      return;
    }

    if (head.ts - src.ts > GRACE_S) {
      missed++;
      pipeline.hincrby(K.metrics(validator), `missed:${from}`, 1);
      pipeline.hincrby(K.metrics(validator), `missed:${from}:${bridge}`, 1);
      pushSample(pipeline, K.missed(validator), {
        bridge,
        dir,
        id: suffix.split(":").slice(2).join(":"),
        age: head.ts - src.ts,
        sourceTx: src.tx,
        ts: src.ts,
      });
      resolved.push(suffix);
    }
    // Otherwise: still within the grace window, leave it pending.
  });

  if (resolved.length) pipeline.zrem(K.pending(validator), ...resolved);
  await pipeline.exec();

  return { validator, checked: suffixes.length, ontime, delayed, missed };
}

export async function reconcileAll() {
  const results = [];
  for (const v of VALIDATORS) results.push(await reconcileValidator(v.name));
  return results;
}
