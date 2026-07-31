import {
  CHAINS,
  EVENT_TTL_S,
  K_CHAIN,
  K_TOPICS,
  BRIDGE_BY_INDEX,
  SOURCES,
  VALIDATORS,
  srcChain,
} from "./config.js";
import { blockNumber, getBlockTimestamps, getLogs, hexToNum, isRangeTooLarge } from "./rpc.js";
import { K, eventKey, redis, setCursor, setHead, getCursor } from "./store.js";

const kAddresses = VALIDATORS.map((v) => v.address);
const validatorByAddress = new Map(VALIDATORS.map((v) => [v.address, v.name]));

// Everything we watch on a given chain, as one address list + one topic list,
// so a range costs a single eth_getLogs call.
function watchlist(chain) {
  const sources = SOURCES.filter((s) => s.chain === chain);
  const addresses = sources.map((s) => s.address);
  const topic0s = [...new Set(sources.map((s) => s.topic0))];
  if (chain === K_CHAIN) {
    addresses.push(...kAddresses);
    topic0s.push(...Object.keys(K_TOPICS));
  }
  return { addresses, topic0s };
}

const sourceByAddressTopic = new Map(SOURCES.map((s) => [`${s.address}|${s.topic0}`, s]));

// Split on "too many results" rather than guessing a safe chunk size up front.
async function fetchLogs(chain, from, to) {
  const { rpc } = CHAINS[chain];
  const { addresses, topic0s } = watchlist(chain);
  try {
    return await getLogs(rpc, { addresses, topic0s, fromBlock: from, toBlock: to });
  } catch (err) {
    if (!isRangeTooLarge(err) || from >= to) throw err;
    const mid = Math.floor((from + to) / 2);
    const [a, b] = [await fetchLogs(chain, from, mid), await fetchLogs(chain, mid + 1, to)];
    return a.concat(b);
  }
}

function classify(log) {
  const address = log.address.toLowerCase();
  const topic0 = log.topics[0];

  const source = sourceByAddressTopic.get(`${address}|${topic0}`);
  if (source) {
    return {
      kind: "source",
      bridge: source.bridge,
      dir: source.dir,
      id: source.idFrom(log),
    };
  }

  const dir = K_TOPICS[topic0];
  const validator = validatorByAddress.get(address);
  if (dir && validator) {
    return {
      kind: "receipt",
      validator,
      bridge: BRIDGE_BY_INDEX[hexToNum(log.topics[1])] ?? "unknown",
      dir,
      id: log.topics[2],
    };
  }
  return null;
}

async function persist(logs, timestamps) {
  const pipeline = redis.pipeline();
  let sources = 0;
  let receipts = 0;

  for (const log of logs) {
    const parsed = classify(log);
    if (!parsed) continue;
    const block = hexToNum(log.blockNumber);
    const ts = timestamps.get(block);
    if (ts === undefined) continue; // block fetch failed; picked up next tick

    const suffix = eventKey(parsed.bridge, parsed.dir, parsed.id);
    const record = JSON.stringify({ tx: log.transactionHash, blk: block, ts });
    const from = srcChain(parsed.dir);

    if (parsed.kind === "source") {
      // NX makes re-indexing a range idempotent: counters move only on first sight.
      const [[, written]] = await redis
        .multi()
        .set(K.src(suffix), record, "EX", EVENT_TTL_S, "NX")
        .exec();
      if (!written) continue;
      sources++;
      pipeline.hincrby(K.metricsGlobal, `src:${from}`, 1);
      pipeline.hincrby(K.metricsGlobal, `src:${from}:${parsed.bridge}`, 1);
      for (const v of VALIDATORS) pipeline.zadd(K.pending(v.name), ts, suffix);
    } else {
      // Validators retry; keep the earliest receipt (logs arrive in block order).
      const [[, written]] = await redis
        .multi()
        .set(K.sig(parsed.validator, suffix), record, "EX", EVENT_TTL_S, "NX")
        .exec();
      if (!written) continue;
      receipts++;
      pipeline.hincrby(K.metrics(parsed.validator), `signed:${from}`, 1);
      pipeline.hincrby(K.metrics(parsed.validator), `signed:${from}:${parsed.bridge}`, 1);
    }
  }

  await pipeline.exec();
  return { sources, receipts };
}

export async function indexChain(chain) {
  const { rpc, confirmations, chunk, startBlock } = CHAINS[chain];
  const head = (await blockNumber(rpc)) - confirmations;
  if (head <= 0) return { chain, indexed: 0 };

  let from = await getCursor(chain);
  if (from === null) {
    // First boot: start from now unless an explicit backfill point is given.
    from = startBlock ?? head;
    await setCursor(chain, from);
  }
  if (from > head) return { chain, from, head, sources: 0, receipts: 0 };

  let sources = 0;
  let receipts = 0;
  while (from <= head) {
    const to = Math.min(from + chunk - 1, head);
    const logs = await fetchLogs(chain, from, to);
    if (logs.length) {
      const blocks = logs.map((l) => hexToNum(l.blockNumber));
      const timestamps = await getBlockTimestamps(rpc, blocks);
      const counts = await persist(logs, timestamps);
      sources += counts.sources;
      receipts += counts.receipts;
    }
    await setCursor(chain, to + 1);
    from = to + 1;
  }

  // "Now" for staleness checks comes from the chain, not the wall clock, so a
  // lagging indexer reports nothing rather than a wave of false misses.
  const headTs = (await getBlockTimestamps(rpc, [head])).get(head);
  if (headTs) await setHead(chain, head, headTs);

  return { chain, head, sources, receipts };
}
