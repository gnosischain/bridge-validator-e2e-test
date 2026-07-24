// FCR observer — Redis backend (oracle validator).
//
// The oracle's fcr watcher + fcrTxsChecker keep their state in Redis, keyed by
// `chain` = "home" (GC) / "foreign" (ETH):
//
//   ${chain}:pendingSafeBlocks        ZSET  member=blockHash, score=blockNumber   (watcher → checker)
//   ${chain}:pendingSafeTxs:<hash>    SET   `${txHash}-${logIndex}`               (watcher)
//   ${chain}:safeTxFalsePositives     LIST  JSON records                          (checker → Grafana)
//
// A false positive is never observable on-chain, so tests read this state to
// synchronize on and assert pending / confirmed / false-positive.

import Redis from "ioredis";

export class RedisObserver {
  constructor(url) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    this._connected = this.redis.connect().catch(() => {});
  }

  async ready() {
    await this._connected;
    return this;
  }

  // True while block `n` sits in the pending ZSET (processed at safe, not yet
  // revalidated at finality).
  async pending(chain, blockNumber) {
    const members = await this.redis.zrangebyscore(
      `${chain}:pendingSafeBlocks`,
      blockNumber,
      blockNumber,
    );
    return members.length > 0;
  }

  // The stored blockHash for block `n` (the ZSET member), or null.
  async pendingHash(chain, blockNumber) {
    const members = await this.redis.zrangebyscore(
      `${chain}:pendingSafeBlocks`,
      blockNumber,
      blockNumber,
    );
    return members[0] ?? null;
  }

  // The `${txHash}-${logIndex}` entries recorded for a pending block hash.
  async pendingTxs(chain, blockHash) {
    return this.redis.smembers(`${chain}:pendingSafeTxs:${blockHash}`);
  }

  // True if a false-positive record references this block (by number or hash).
  // Record shape isn't contractually fixed, so match defensively.
  async falsePositive(chain, blockNumber, blockHash) {
    const records = await this.redis.lrange(
      `${chain}:safeTxFalsePositives`,
      0,
      -1,
    );
    return records.some((raw) => {
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        return Boolean(blockHash) && raw.includes(blockHash);
      }
      const bn = rec.blockNumber ?? rec.block ?? rec.number;
      if (bn !== undefined && Number(bn) === Number(blockNumber)) return true;
      if (blockHash && (rec.blockHash === blockHash || rec.hash === blockHash))
        return true;
      if (blockHash && raw.includes(blockHash)) return true;
      return false;
    });
  }

  // Confirmed = the checker validated the hash at finality and pruned the entry,
  // and it is NOT recorded as a false positive. Only meaningful after the block
  // was observed pending (the flow enforces that ordering).
  async confirmed(chain, blockNumber, blockHash) {
    if (await this.pending(chain, blockNumber)) return false;
    return !(await this.falsePositive(chain, blockNumber, blockHash));
  }

  // Raw false-positive records (JSON-parsed where possible) — for assertions.
  async falsePositiveRecords(chain) {
    const raw = await this.redis.lrange(`${chain}:safeTxFalsePositives`, 0, -1);
    return raw.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return r;
      }
    });
  }

  async close() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
